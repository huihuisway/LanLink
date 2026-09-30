package lanlink.tunnel;

import arc.util.Log;

import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * UDP 隧道（协议见 proto/PROTOCOL.md §3.2）。
 *
 * 铁律（RESEARCH.md §2）：每个 sessionId 一个独立本地 UDP socket 与
 * 127.0.0.1:gamePort 通信 —— ArcNet 按源地址路由，混用必串包。
 */
public class UdpBridge{
    private static final byte[] MAGIC = {'L', 'L', 'K', 'U'};
    private static final byte TYPE_DATA = 0x01, TYPE_CLOSE = 0x02, TYPE_REGISTER = 0x03;
    private static final int MAX_PACKET = 65507;

    private final InetSocketAddress node;
    private final byte[] roomToken;
    private final int gamePort;
    private final InetAddress localhost;

    private DatagramSocket tunnel;
    private final Map<Integer, Session> sessions = new ConcurrentHashMap<>();
    private volatile boolean running;

    private class Session{
        final int id;
        final DatagramSocket local;
        int rxFromGame, txToGame;

        Session(int id) throws Exception{
            this.id = id;
            this.local = new DatagramSocket(0, localhost);
            Log.info("[LanLink] UDP session " + id + " 建立，本地端口 " + local.getLocalPort());
            Thread t = new Thread(() -> {
                byte[] buf = new byte[MAX_PACKET];
                DatagramPacket p = new DatagramPacket(buf, buf.length);
                try{
                    while(running && !local.isClosed()){
                        // receive 会把 p 的长度改成实际收到的字节数，不重置则后续包被截断
                        p.setLength(buf.length);
                        local.receive(p);
                        rxFromGame++;
                        // 回程：本地游戏 → 封帧 → 节点
                        byte[] frame = new byte[7 + p.getLength()];
                        System.arraycopy(MAGIC, 0, frame, 0, 4);
                        frame[4] = TYPE_DATA;
                        frame[5] = (byte)(id >> 8);
                        frame[6] = (byte)id;
                        System.arraycopy(p.getData(), p.getOffset(), frame, 7, p.getLength());
                        tunnel.send(new DatagramPacket(frame, frame.length, node));
                        if(rxFromGame % 10 == 0){
                            Log.info("[LanLink] UDP session " + id + " 游戏回程 " + rxFromGame + " 包");
                        }
                    }
                }catch(Throwable ignored){
                }
            }, "lanlink-udp-session-" + id);
            t.setDaemon(true);
            t.start();
        }

        void toGame(byte[] data, int off, int len) throws Exception{
            local.send(new DatagramPacket(data, off, len, localhost, gamePort));
            txToGame++;
            if(txToGame % 10 == 0){
                Log.info("[LanLink] UDP session " + id + " 发游戏 " + txToGame + " 包");
            }
        }

        void close(){
            Log.info("[LanLink] UDP session " + id + " 关闭，总计：游戏→节点 " + rxFromGame + " 包，节点→游戏 " + txToGame + " 包");
            local.close();
        }
    }

    public UdpBridge(InetSocketAddress node, byte[] roomToken, int gamePort) throws Exception{
        this.node = node;
        this.roomToken = roomToken;
        this.gamePort = gamePort;
        this.localhost = InetAddress.getByName("127.0.0.1");
    }

    public void start() throws Exception{
        tunnel = new DatagramSocket();
        running = true;

        // 隧道读线程：节点 → 解帧 → 对应 session 的本地 socket → 游戏
        Thread reader = new Thread(() -> {
            byte[] buf = new byte[MAX_PACKET];
            DatagramPacket p = new DatagramPacket(buf, buf.length);
            while(running && !tunnel.isClosed()){
                try{
                    // 同上：每次收包前恢复缓冲区全长，否则后续包被截断
                    p.setLength(buf.length);
                    tunnel.receive(p);
                    byte[] d = p.getData();
                    int len = p.getLength();
                    if(len < 5 || d[0] != 'L' || d[1] != 'L' || d[2] != 'K' || d[3] != 'U') continue;
                    byte type = d[4];
                    if(type == TYPE_DATA && len >= 7){
                        int sid = ((d[5] & 0xff) << 8) | (d[6] & 0xff);
                        Session s = sessions.get(sid);
                        if(s == null){
                            s = new Session(sid);
                            sessions.put(sid, s);
                        }
                        s.toGame(d, 7, len - 7);
                    }else if(type == TYPE_CLOSE && len >= 7){
                        int sid = ((d[5] & 0xff) << 8) | (d[6] & 0xff);
                        Session s = sessions.remove(sid);
                        if(s != null) s.close();
                    }
                }catch(Throwable t){
                    if(running) Log.err("[LanLink] udp tunnel read", t);
                }
            }
        }, "lanlink-udp-tunnel");
        reader.setDaemon(true);
        reader.start();

        // 注册 + 25s 保活（同一帧型，NAT 保活与注册合一）
        Thread keepalive = new Thread(() -> {
            byte[] frame = new byte[5 + roomToken.length];
            System.arraycopy(MAGIC, 0, frame, 0, 4);
            frame[4] = TYPE_REGISTER;
            System.arraycopy(roomToken, 0, frame, 5, roomToken.length);
            while(running && !tunnel.isClosed()){
                try{
                    tunnel.send(new DatagramPacket(frame, frame.length, node));
                    Thread.sleep(25_000);
                }catch(InterruptedException e){
                    return;
                }catch(Throwable t){
                    if(running) Log.err("[LanLink] udp register", t);
                }
            }
        }, "lanlink-udp-keepalive");
        keepalive.setDaemon(true);
        keepalive.start();
    }

    public int sessionCount(){
        return sessions.size();
    }

    public void close(){
        running = false;
        for(Session s : sessions.values()) s.close();
        sessions.clear();
        if(tunnel != null) tunnel.close();
    }
}
