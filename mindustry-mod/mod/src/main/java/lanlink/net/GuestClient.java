package lanlink.net;

import arc.func.Cons;
import arc.util.Log;
import arc.util.serialization.Jval;
import lanlink.shaded.ws.client.WebSocket;
import lanlink.shaded.ws.client.WebSocketAdapter;
import lanlink.shaded.ws.client.WebSocketFactory;
import lanlink.shaded.ws.client.WebSocketFrame;

/**
 * 客人 ↔ 控制面 WebSocket 通道（协议见 proto/PROTOCOL.md §1b，/ws/guest）。
 * 与 ControlClient 结构相同，但用于加入方 Mod。
 */
public class GuestClient{
    private WebSocket ws;
    private volatile boolean closedByUser;

    public Cons<Jval> onMessage = j -> {};
    public Runnable onConnected = () -> {};
    public Cons<String> onDisconnected = r -> {};

    public synchronized void connect(String url) throws Exception{
        closedByUser = false;
        ws = new WebSocketFactory()
            .setConnectionTimeout(8000)
            .createSocket(url)
            .addListener(new WebSocketAdapter(){
                @Override
                public void onConnected(WebSocket s, java.util.Map<String, java.util.List<String>> headers){
                    onConnected.run();
                }

                @Override
                public void onTextMessage(WebSocket s, String text){
                    try{
                        onMessage.get(Jval.read(text));
                    }catch(Throwable t){
                        Log.err("[LanLink] bad guest message: " + text, t);
                    }
                }

                @Override
                public void onDisconnected(WebSocket s, WebSocketFrame serverFrame, WebSocketFrame clientFrame, boolean byServer){
                    if(!closedByUser) onDisconnected.get(byServer ? "server closed" : "connection lost");
                }

                @Override
                public void onError(WebSocket s, lanlink.shaded.ws.client.WebSocketException cause){
                    Log.err("[LanLink] guest ws error", cause);
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
