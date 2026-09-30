package lanlink.net;

import arc.util.Log;

import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.InetSocketAddress;
import java.nio.ByteBuffer;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;

/**
 * UDP 双向打洞：双方各向对方候选地址发送探测包，最先双向通的当选。
 *
 * 协议：
 *   探测包（probe）: [4B "LLHP"][16B roomToken][1B type=0x01][2B seq]
 *   回应包（reply）: [4B "LLHP"][16B roomToken][1B type=0x02][2B seq]
 *
 * 流程：
 *   - 本地绑定到 ephemeral 端口（不与游戏端口冲突）
 *   - 向所有远端候选地址发探测包，按 200/400/800/1600/3200ms 重传
 *   - 收到对端探测包 → 立即回回应包 + 记录对方地址
 *   - 收到回应包（且 roomToken 匹配）→ 视为该候选双向可达，回调成功
 *   - 总超时 TOTAL_TIMEOUT_MS（默认 5s）后仍未成功则回调失败
 *
 * 适用：full cone / restricted NAT。对称 NAT 不可用，会回退中继。
 */
public class HolePuncher{

    private static final byte[] MAGIC = {'L', 'L', 'H', 'P'};
    private static final byte TYPE_PROBE = 0x01;
    private static final byte TYPE_REPLY = 0x02;
    private static final int[] BACKOFF_MS = {200, 400, 800, 1600, 3200};
    private static final int MAX_CANDIDATES = 5;
    private static final int TOTAL_TIMEOUT_MS = 5000;
    private static final int PACKET_SIZE = 4 + 16 + 1 + 2;  // 23 bytes

    public static class CandidateAddress{
        public final String addr;
        public final int port;

        public CandidateAddress(String addr, int port){
            this.addr = addr;
            this.port = port;
        }
    }

    public interface Callback{
        void onSuccess(String addr, int port);
        void onFailed();
    }

    private volatile boolean stopped;
    private DatagramSocket socket;
    private Thread reader;
    private Thread sender;

    /**
     * 开始打洞。
     * @param remoteCandidates 对方候选地址
     * @param roomToken        16 字节房间令牌（用于匹配回应）
     * @param cb               成功/失败回调（在打洞线程上调用，调用方需切回主线程）
     */
    public void start(List<CandidateAddress> remoteCandidates, byte[] roomToken, Callback cb){
        if(remoteCandidates == null || remoteCandidates.isEmpty()){
            cb.onFailed();
            return;
        }
        // 限制候选数量
        List<CandidateAddress> targets = remoteCandidates.size() > MAX_CANDIDATES
            ? remoteCandidates.subList(0, MAX_CANDIDATES) : remoteCandidates;

        try{
            socket = new DatagramSocket(0);
            socket.setSoTimeout(500);
        }catch(Throwable t){
            Log.err("[LanLink] HolePuncher socket bind failed", t);
            cb.onFailed();
            return;
        }

        stopped = false;
        final byte[] token = roomToken.clone();

        // 接收线程
        reader = new Thread(() -> {
            byte[] buf = new byte[256];
            while(!stopped){
                try{
                    DatagramPacket p = new DatagramPacket(buf, buf.length);
                    socket.receive(p);
                    if(p.getLength() < PACKET_SIZE) continue;
                    ByteBuffer bb = ByteBuffer.wrap(buf, 0, p.getLength());
                    byte[] magic = new byte[4];
                    bb.get(magic);
                    if(magic[0] != MAGIC[0] || magic[1] != MAGIC[1]
                        || magic[2] != MAGIC[2] || magic[3] != MAGIC[3]) continue;
                    byte[] pktToken = new byte[16];
                    bb.get(pktToken);
                    if(!matchesToken(pktToken, token)) continue;
                    byte type = bb.get();
                    short seq = bb.getShort();

                    if(type == TYPE_PROBE){
                        // 收到探测 → 立即回应 + 记录对方地址
                        sendReply(p.getAddress().getHostAddress(), p.getPort(), token, seq);
                    }else if(type == TYPE_REPLY){
                        // 收到回应 → 成功
                        String addr = p.getAddress().getHostAddress();
                        int port = p.getPort();
                        Log.info("[LanLink] HolePunch success: @:@", addr, port);
                        stop();
                        cb.onSuccess(addr, port);
                        return;
                    }
                }catch(Throwable t){
                    if(!stopped) continue;
                }
            }
        }, "lanlink-holepunch-rx");
        reader.setDaemon(true);
        reader.start();

        // 发送线程（带退避重传）
        sender = new Thread(() -> {
            short seq = 0;
            long startMs = System.currentTimeMillis();
            try{
                for(int round = 0; round < BACKOFF_MS.length && !stopped; round++){
                    // 一轮内对所有候选发包
                    for(CandidateAddress c : targets){
                        if(stopped) return;
                        sendProbe(c.addr, c.port, token, seq++);
                    }
                    // 等待本轮间隔
                    long waited = System.currentTimeMillis() - startMs;
                    if(waited >= TOTAL_TIMEOUT_MS) break;
                    long sleepMs = Math.min(BACKOFF_MS[round], TOTAL_TIMEOUT_MS - waited);
                    Thread.sleep(sleepMs);
                }
                // 最后一轮后等 1s 收尾
                long waited = System.currentTimeMillis() - startMs;
                if(waited < TOTAL_TIMEOUT_MS){
                    Thread.sleep(Math.min(1000, TOTAL_TIMEOUT_MS - waited));
                }
            }catch(InterruptedException ignored){
            }catch(Throwable t){
                Log.err("[LanLink] HolePuncher sender", t);
            }
            if(!stopped){
                stop();
                cb.onFailed();
            }
        }, "lanlink-holepunch-tx");
        sender.setDaemon(true);
        sender.start();
    }

    public void stop(){
        stopped = true;
        try{ if(socket != null) socket.close(); }catch(Throwable ignored){}
    }

    private void sendProbe(String addr, int port, byte[] token, short seq){
        send(TYPE_PROBE, addr, port, token, seq);
    }

    private void sendReply(String addr, int port, byte[] token, short seq){
        send(TYPE_REPLY, addr, port, token, seq);
    }

    private void send(byte type, String addr, int port, byte[] token, short seq){
        try{
            ByteBuffer bb = ByteBuffer.allocate(PACKET_SIZE);
            bb.put(MAGIC);
            bb.put(token);
            bb.put(type);
            bb.putShort(seq);
            byte[] data = bb.array();
            DatagramPacket p = new DatagramPacket(data, data.length,
                new InetSocketAddress(addr, port));
            socket.send(p);
        }catch(Throwable t){
            // 单个候选失败不影响整体
        }
    }

    private boolean matchesToken(byte[] a, byte[] b){
        if(a.length != b.length) return false;
        int diff = 0;
        for(int i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
        return diff == 0;
    }
}
