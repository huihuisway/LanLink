package lanlink.tunnel;

import java.io.InputStream;
import java.io.OutputStream;
import java.net.Socket;

/**
 * 两条 TCP 连接的双向透传（节点数据链 ↔ 本地游戏端口），任一端关闭即整体关闭。
 */
public class TcpBridge{
    private final Socket a, b;
    private volatile boolean closed;
    public Runnable onClosed = () -> {};

    public TcpBridge(Socket a, Socket b){
        this.a = a;
        this.b = b;
    }

    public void start(int connId){
        pump("lanlink-tcp-" + connId + "-up", a, b);
        pump("lanlink-tcp-" + connId + "-down", b, a);
    }

    private void pump(String name, Socket from, Socket to){
        Thread t = new Thread(() -> {
            byte[] buf = new byte[16384];
            try{
                InputStream in = from.getInputStream();
                OutputStream out = to.getOutputStream();
                int n;
                while((n = in.read(buf)) != -1){
                    out.write(buf, 0, n);
                    out.flush();
                }
            }catch(Throwable ignored){
            }finally{
                close();
            }
        }, name);
        t.setDaemon(true);
        t.start();
    }

    public synchronized void close(){
        if(closed) return;
        closed = true;
        try{ a.close(); }catch(Throwable ignored){}
        try{ b.close(); }catch(Throwable ignored){}
        onClosed.run();
    }
}
