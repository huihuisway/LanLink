package lanlink.net;

import arc.func.Cons;
import arc.util.Log;
import arc.util.serialization.Jval;
import lanlink.shaded.ws.client.WebSocket;
import lanlink.shaded.ws.client.WebSocketAdapter;
import lanlink.shaded.ws.client.WebSocketFactory;
import lanlink.shaded.ws.client.WebSocketFrame;

/**
 * Mod ↔ 控制面 WebSocket 控制通道（协议见 proto/PROTOCOL.md §1）。
 * 所有回调都在 WS 线程触发，调用方自行切回主线程。
 */
public class ControlClient{
    private WebSocket ws;
    private volatile boolean closedByUser;
    private volatile boolean hasConnected;

    public Cons<Jval> onMessage = j -> {};
    public Runnable onConnected = () -> {};
    /** 参数为断开原因描述。closedByUser 时不触发。 */
    public Cons<String> onDisconnected = r -> {};

    public synchronized void connect(String url) throws Exception{
        closedByUser = false;
        hasConnected = false;
        ws = new WebSocketFactory()
            .setConnectionTimeout(8000)
            .createSocket(url)
            .addListener(new WebSocketAdapter(){
                @Override
                public void onConnected(WebSocket s, java.util.Map<String, java.util.List<String>> headers){
                    hasConnected = true;
                    onConnected.run();
                }

                @Override
                public void onTextMessage(WebSocket s, String text){
                    try{
                        onMessage.get(Jval.read(text));
                    }catch(Throwable t){
                        Log.err("[LanLink] bad control message: " + text, t);
                    }
                }

                @Override
                public void onDisconnected(WebSocket s, WebSocketFrame serverFrame, WebSocketFrame clientFrame, boolean byServer){
                    if(!closedByUser) onDisconnected.get(byServer ? "server closed" : "connection lost");
                }

                @Override
                public void onError(WebSocket s, lanlink.shaded.ws.client.WebSocketException cause){
                    Log.err("[LanLink] ws error", cause);
                    // 如果尚未成功连接过，将错误传播到 onDisconnected，让 UI 感知到失败
                    if(!hasConnected && !closedByUser){
                        String reason = cause != null ? cause.getMessage() : "connection error";
                        if(reason == null) reason = "connection error";
                        onDisconnected.get(reason);
                    }
                }
            });
        ws.connectAsynchronously();
    }

    public synchronized void send(Jval obj){
        WebSocket w = ws;
        if(w != null && w.isOpen()) w.sendText(obj.toString());
    }

    public synchronized boolean isOpen(){
        return ws != null && ws.isOpen();
    }

    public synchronized void close(){
        closedByUser = true;
        if(ws != null){
            ws.disconnect();
            ws = null;
        }
    }
}
