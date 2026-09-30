package lanlink.net;

import arc.util.Log;

import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.InetAddress;
import java.nio.ByteBuffer;
import java.security.SecureRandom;

/**
 * 最小 RFC 5389 STUN Binding Request 客户端。
 * - 20 字节头：type=0x0001, length=0, magic=0x2112A442, 12 字节随机 transaction id
 * - 解析 XOR-MAPPED-ADDRESS (0x0020) 或 MAPPED-ADDRESS (0x0001)
 * - 默认服务器：stun.nextcloud.com:443, Google/Cloudflare 公共 STUN fallback
 * - 纯 DatagramSocket，Java 8 + Android 兼容
 * - 超时：每服务器 2.5s
 */
public final class StunClient{

    private static final int MAGIC_COOKIE = 0x2112A442;
    private static final int BINDING_REQUEST = 0x0001;
    private static final int BINDING_SUCCESS = 0x0101;
    private static final int ATTR_MAPPED_ADDRESS = 0x0001;
    private static final int ATTR_XOR_MAPPED_ADDRESS = 0x0020;
    private static final int SOCKET_TIMEOUT_MS = 2500;

    // 用户确认主用 stun.nextcloud.com，公共 fallback
    private static final String[][] DEFAULT_SERVERS = {
        {"stun.nextcloud.com", "443"},
        {"stun.l.google.com", "19302"},
        {"stun1.l.google.com", "19302"},
        {"stun2.l.google.com", "19302"},
        {"stun.cloudflare.com", "3478"}
    };

    private static final SecureRandom RANDOM = new SecureRandom();

    private StunClient(){
    }

    public static DirectCandidate discover(){
        return discover(null, 0);
    }

    public static DirectCandidate discover(String customHost, int customPort){
        if(customHost != null && !customHost.isEmpty()){
            int port = customPort > 0 ? customPort : 3478;
            DirectCandidate r = tryStun(customHost, port);
            if(r.ok) return r;
        }
        for(String[] s : DEFAULT_SERVERS){
            DirectCandidate r = tryStun(s[0], Integer.parseInt(s[1]));
            if(r.ok) return r;
        }
        return DirectCandidate.fail("STUN 发现失败，所有服务器无响应");
    }

    private static DirectCandidate tryStun(String host, int port){
        try(DatagramSocket socket = new DatagramSocket()){
            socket.setSoTimeout(SOCKET_TIMEOUT_MS);

            // 构造 Binding Request（20 字节）
            byte[] txId = new byte[12];
            RANDOM.nextBytes(txId);
            byte[] request = new byte[20];
            request[0] = 0; request[1] = (byte)BINDING_REQUEST;    // type
            request[2] = 0; request[3] = 0;                        // length = 0
            request[4] = (byte)(MAGIC_COOKIE >>> 24);
            request[5] = (byte)(MAGIC_COOKIE >>> 16);
            request[6] = (byte)(MAGIC_COOKIE >>> 8);
            request[7] = (byte)MAGIC_COOKIE;
            System.arraycopy(txId, 0, request, 8, 12);

            InetAddress addr = InetAddress.getByName(host);
            DatagramPacket out = new DatagramPacket(request, request.length, addr, port);
            socket.send(out);

            byte[] buf = new byte[1500];
            DatagramPacket in = new DatagramPacket(buf, buf.length);
            socket.receive(in);

            return parseResponse(buf, in.getLength(), txId, host);
        }catch(Throwable t){
            Log.info("[LanLink] STUN " + host + ":" + port + " failed: " + t.getMessage());
            return DirectCandidate.fail("");
        }
    }

    private static DirectCandidate parseResponse(byte[] buf, int length, byte[] txId, String server){
        if(length < 20) return DirectCandidate.fail("");

        // 校验：type=0x0101, magic, transaction id
        int type = ((buf[0] & 0xff) << 8) | (buf[1] & 0xff);
        if(type != BINDING_SUCCESS) return DirectCandidate.fail("");

        int magic = ((buf[4] & 0xff) << 24) | ((buf[5] & 0xff) << 16)
            | ((buf[6] & 0xff) << 8) | (buf[7] & 0xff);
        if(magic != MAGIC_COOKIE) return DirectCandidate.fail("");

        for(int i = 0; i < 12; i++){
            if(buf[8 + i] != txId[i]) return DirectCandidate.fail("");
        }

        int msgLen = ((buf[2] & 0xff) << 8) | (buf[3] & 0xff);
        int offset = 20;
        int end = 20 + msgLen;
        if(end > length) end = length;

        String mappedAddr = null;
        int mappedPort = 0;

        while(offset + 4 <= end){
            int attrType = ((buf[offset] & 0xff) << 8) | (buf[offset + 1] & 0xff);
            int attrLen = ((buf[offset + 2] & 0xff) << 8) | (buf[offset + 3] & 0xff);
            offset += 4;
            if(offset + attrLen > end) break;

            if(attrType == ATTR_XOR_MAPPED_ADDRESS && attrLen >= 8){
                // family: 1 字节, port: 2 字节 XOR magic>>16, addr: 4 字节 XOR magic
                int family = buf[offset + 1] & 0xff;
                if(family == 0x01){ // IPv4
                    int xPort = ((buf[offset + 2] & 0xff) << 8) | (buf[offset + 3] & 0xff);
                    mappedPort = xPort ^ (MAGIC_COOKIE >>> 16);
                    int xIp = ((buf[offset + 4] & 0xff) << 24) | ((buf[offset + 5] & 0xff) << 16)
                        | ((buf[offset + 6] & 0xff) << 8) | (buf[offset + 7] & 0xff);
                    int ip = xIp ^ MAGIC_COOKIE;
                    mappedAddr = ((ip >>> 24) & 0xff) + "." + ((ip >>> 16) & 0xff) + "."
                        + ((ip >>> 8) & 0xff) + "." + (ip & 0xff);
                }
            }else if(attrType == ATTR_MAPPED_ADDRESS && attrLen >= 8 && mappedAddr == null){
                int family = buf[offset + 1] & 0xff;
                if(family == 0x01){ // IPv4
                    mappedPort = ((buf[offset + 2] & 0xff) << 8) | (buf[offset + 3] & 0xff);
                    mappedAddr = (buf[offset + 4] & 0xff) + "." + (buf[offset + 5] & 0xff) + "."
                        + (buf[offset + 6] & 0xff) + "." + (buf[offset + 7] & 0xff);
                }
            }

            // attribute 4 字节对齐
            offset += attrLen;
            int pad = (4 - (attrLen % 4)) % 4;
            offset += pad;
        }

        if(mappedAddr != null && mappedPort > 0 && mappedPort <= 65535){
            return DirectCandidate.stun(mappedAddr, mappedPort);
        }
        return DirectCandidate.fail("");
    }
}
