package lanlink.tunnel;

import arc.Core;
import arc.util.Log;
import arc.util.serialization.Jval;
import lanlink.BuildInfo;
import lanlink.net.ControlClient;
import lanlink.net.DirectCandidate;
import lanlink.net.DirectDiscovery;
import lanlink.net.HolePuncher;
import lanlink.net.PortMapper;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.function.Consumer;

/**
 * 生命周期状态机：开房 → 控制链/UDP 隧道建立 → 客人接入 → 关房清理。
 * 协议见 proto/PROTOCOL.md。所有对外状态变更通过 onStateChanged 通知（已切主线程）。
 */
public class TunnelManager{
    public enum State{IDLE, CONNECTING, OPEN, ERROR}

    public static class OpenOptions{
        public String controlUrl = "";
        public int gamePort = 6567;
        public String roomName = "";
        public String selectedNodeId = "";
        public String manualRelayAddr = "";
        public int manualRelayTunnelPort;
        public boolean enableDirect = true;
        public String token = "";
        public boolean publicRoom;
    }

    private static final byte[] MAGIC = {'L', 'L', 'K', '1'};
    private static final byte LINK_CONTROL = 0x01, LINK_DATA = 0x02;

    public static final int PROTOCOL_VER = 2;

    private volatile State state = State.IDLE;
    public volatile String statusText = "";
    public volatile String roomCode = "", publicAddr = "";
    public volatile String displayName = "", nodeName = "", serverVersion = "";
    public volatile String directStatusText = "", directPublicAddr = "";

    public Runnable onStateChanged = () -> {};
    public Consumer<InviteInfo> onInviteReceived = info -> {};

    public static class InviteInfo{
        public final String fromId, fromUsername, fromAvatarUrl;
        public final String roomCode, roomName, roomDisplayName;
        public final int expiresIn;

        public InviteInfo(String fromId, String fromUsername, String fromAvatarUrl,
                          String roomCode, String roomName, String roomDisplayName, int expiresIn){
            this.fromId = fromId == null ? "" : fromId;
            this.fromUsername = fromUsername == null ? "" : fromUsername;
            this.fromAvatarUrl = fromAvatarUrl == null ? "" : fromAvatarUrl;
            this.roomCode = roomCode == null ? "" : roomCode;
            this.roomName = roomName == null ? "" : roomName;
            this.roomDisplayName = roomDisplayName == null ? "" : roomDisplayName;
            this.expiresIn = expiresIn;
        }
    }

    private ControlClient control;
    private PortMapper portMapper;
    private List<DirectCandidate> directCandidates = new ArrayList<>();
    private Socket controlLink;
    private OutputStream controlOut;
    private UdpBridge udp;
    private final Map<Integer, TcpBridge> bridges = new ConcurrentHashMap<>();

    private String nodeAddr;
    private int tunnelPort, gamePort;
    private byte[] roomToken;

    // 最后一次 open 参数，用于重试
    private OpenOptions lastOpenOptions;

    // 当前活跃的打洞器（房主对每个客人的探测）
    private final List<HolePuncher> activeHolePunchers = new ArrayList<>();

    public State state(){
        return state;
    }

    public int guestCount(){
        return bridges.size();
    }

    /** 开房。要求本地已 net.host()。 */
    public synchronized void open(OpenOptions opts){
        if(state == State.CONNECTING || state == State.OPEN) return;
        int seq = ++openSeq;
        this.gamePort = opts.gamePort;
        this.pendingRoomName = opts.roomName;
        this.pendingSelectedNodeId = opts.selectedNodeId == null ? "" : opts.selectedNodeId.trim();
        this.pendingManualRelayAddr = opts.manualRelayAddr == null ? "" : opts.manualRelayAddr.trim();
        this.pendingManualRelayTunnelPort = opts.manualRelayTunnelPort;
        this.pendingEnableDirect = opts.enableDirect;
        this.pendingToken = opts.token == null ? "" : opts.token.trim();
        this.pendingPublicRoom = opts.publicRoom;
        this.lastOpenOptions = opts;
        directCandidates = new ArrayList<>();
        directStatusText = "";
        directPublicAddr = "";
        setState(State.CONNECTING, pendingEnableDirect ? "直连发现（UPnP + STUN）…" : "连接控制面…");

        String controlUrl = opts.controlUrl;
        int localGamePort = opts.gamePort;
        boolean enableDirect = opts.enableDirect;
        Thread opener = new Thread(() -> {
            if(enableDirect){
                DirectDiscovery.DiscoveryResult result = DirectDiscovery.discover(
                    localGamePort,
                    null,  // 不再支持手动直连地址
                    0,     // 不再支持手动直连端口
                    null,  // 不再支持 STUN 服务器覆盖
                    step -> {
                        synchronized(TunnelManager.this){
                            if(isCurrentSeq(seq)) directStatusText = step;
                        }
                        notifyUi();
                    }
                );
                synchronized(this){
                    if(!isCurrentSeq(seq)){
                        if(result.portMapper != null) result.portMapper.close();
                        return;
                    }
                    directCandidates = result.candidates;
                    portMapper = result.portMapper;
                    directStatusText = result.statusText;
                    if(!result.candidates.isEmpty()){
                        DirectCandidate best = result.candidates.get(0);
                        directPublicAddr = best.addr + ":" + best.port;
                    }
                }
                notifyUi();
            }
            if(isCurrentSeq(seq)) connectControl(seq, controlUrl);
        }, "lanlink-open");
        opener.setDaemon(true);
        opener.start();
    }

    /** 重试（用 lastOpenOptions）。ERROR 状态下由 UI 调用。 */
    public synchronized void retry(){
        if(lastOpenOptions != null){
            State s = state;
            if(s == State.ERROR || s == State.IDLE){
                state = State.IDLE;  // 让 open 通过检查
                open(lastOpenOptions);
            }
        }
    }

    private int openSeq;

    private String pendingRoomName = "";
    private String pendingSelectedNodeId = "";
    private String pendingManualRelayAddr = "";
    private int pendingManualRelayTunnelPort;
    private boolean pendingEnableDirect;
    private String pendingToken = "";
    private boolean pendingPublicRoom;

    private synchronized boolean isCurrentSeq(int seq){
        return openSeq == seq && state != State.IDLE && state != State.ERROR;
    }

    private void connectControl(int seq, String controlUrl){
        if(!isCurrentSeq(seq)) return;
        setState(State.CONNECTING, "连接控制面…");

        ControlClient client = new ControlClient();
        client.onConnected = () -> {
            if(!isCurrentSeq(seq)) return;
            Jval hello = Jval.newObject();
            hello.put("op", "hello");
            hello.put("ver", PROTOCOL_VER);
            hello.put("build", lanlink.Compat.gameBuild());
            hello.put("platform", Core.app.isAndroid() ? "android" : "desktop");
            hello.put("mod_version", BuildInfo.MOD_VERSION);
            hello.put("token", pendingToken);
            client.send(hello);
        };
        client.onDisconnected = reason -> {
            if(isCurrentSeq(seq)) fail("控制面断开: " + reason);
        };
        client.onMessage = j -> {
            if(isCurrentSeq(seq)) handleControl(j);
        };
        synchronized(this){
            if(!isCurrentSeq(seq)){
                client.close();
                return;
            }
            control = client;
        }
        try{
            client.connect(controlUrl + "/ws/mod");
        }catch(Throwable t){
            if(isCurrentSeq(seq)) fail("无法连接控制面: " + t.getMessage());
        }
    }

    private void handleControl(Jval j){
        String op = j.getString("op", "");
        switch(op){
            case "hello_ok" -> {
                serverVersion = j.getString("server_version", j.getString("latest", ""));
                Jval create = Jval.newObject();
                create.put("op", "create_room");
                create.put("name", pendingRoomName);
                create.put("public", pendingPublicRoom);
                create.put("vanilla_join", true);
                create.put("game_port", gamePort);
                if(!pendingSelectedNodeId.isEmpty()) create.put("node_id", pendingSelectedNodeId);
                if(!pendingManualRelayAddr.isEmpty()){
                    create.put("relay_addr", pendingManualRelayAddr);
                    if(pendingManualRelayTunnelPort > 0) create.put("relay_tunnel_port", pendingManualRelayTunnelPort);
                }
                // M2：发送 direct（兼容旧控制面）+ direct_candidates 数组
                if(!directCandidates.isEmpty()){
                    DirectCandidate best = directCandidates.get(0);
                    Jval direct = Jval.newObject();
                    direct.put("mode", best.mode);
                    direct.put("addr", best.addr);
                    direct.put("tcp_port", best.port);
                    direct.put("udp_port", best.port);
                    direct.put("ttl", "upnp".equals(best.mode) ? 3600 : 0);
                    create.put("direct", direct);

                    Jval arr = Jval.newArray();
                    for(DirectCandidate c : directCandidates){
                        Jval item = Jval.newObject();
                        item.put("mode", c.mode);
                        item.put("addr", c.addr);
                        item.put("tcp_port", c.port);
                        item.put("udp_port", c.port);
                        item.put("ttl", "upnp".equals(c.mode) ? 3600 : 0);
                        arr.add(item);
                    }
                    create.put("direct_candidates", arr);
                }
                control.send(create);
            }
            case "room_ok" -> {
                try{
                    roomCode = j.getString("code", "");
                    roomToken = hexToBytes(j.getString("room_token", ""));
                    Jval node = j.get("node");
                    nodeName = node.getString("name", node.getString("id", ""));
                    serverVersion = j.getString("server_version", serverVersion);
                    displayName = j.getString("display_name", "");
                    nodeAddr = node.getString("addr", "");
                    tunnelPort = node.getInt("tunnel_port", 0);
                    int roomPort = node.getInt("room_port", 0);
                    publicAddr = nodeAddr + ":" + roomPort;
                    openTunnel();
                    setState(State.OPEN, "房间已开放");
                }catch(Throwable t){
                    fail("建立隧道失败: " + t.getMessage());
                }
            }
            case "room_closed" -> fail("房间已关闭: " + j.getString("reason", "?"));
            case "error" -> {
                String code = j.getString("code", "?");
                String msg = j.getString("msg", "");
                // 版本相关错误：提供友好的升级提示
                if("upgrade_required".equals(code)){
                    String downloadUrl = j.getString("url", "");
                    String latestVersion = j.getString("latest", "");
                    int requiredVersion = j.getInt("required_version", 0);
                    StringBuilder friendlyMsg = new StringBuilder();
                    friendlyMsg.append("LanLink Mod 版本过旧，请更新到最新版本");
                    if(!latestVersion.isEmpty()){
                        friendlyMsg.append("\n最新版本: ").append(latestVersion);
                    }
                    if(requiredVersion > 0){
                        friendlyMsg.append("\n需要协议版本: ").append(requiredVersion);
                    }
                    if(!downloadUrl.isEmpty()){
                        friendlyMsg.append("\n\n下载地址: ").append(downloadUrl);
                        friendlyMsg.append("\n或访问论坛获取最新版本");
                    }
                    fail(friendlyMsg.toString());
                }else{
                    fail("控制面错误: " + code + " " + msg);
                }
            }
            case "peer_join" -> {
                // M2：客人加入，提取客人候选启动打洞（房主侧）
                Jval peerCandidates = j.get("peer_candidates");
                if(peerCandidates != null && roomToken != null){
                    List<HolePuncher.CandidateAddress> addrs = new ArrayList<>();
                    for(Jval c : peerCandidates.asArray()){
                        String addr = c.getString("addr", "");
                        int port = c.getInt("udp_port", 0);
                        if(!addr.isEmpty() && port > 0) addrs.add(new HolePuncher.CandidateAddress(addr, port));
                    }
                    if(!addrs.isEmpty()) startHostHolePunch(addrs);
                }
            }
            case "ping" -> {
                Jval pong = Jval.newObject();
                pong.put("op", "pong");
                control.send(pong);
            }
            case "invite_received" -> {
                Jval from = j.get("from");
                Jval room = j.get("room");
                int expiresIn = j.getInt("expires_in", 600);
                Core.app.post(() -> {
                    onInviteReceived.accept(new InviteInfo(
                        from.getString("id", ""),
                        from.getString("username", ""),
                        from.getString("avatar_url", ""),
                        room.getString("code", ""),
                        room.getString("name", ""),
                        room.getString("display_name", ""),
                        expiresIn
                    ));
                });
            }
            default -> {}
        }
    }

    private void openTunnel() throws Exception{
        // 控制链：握手 25 字节 [LLK1][0x01][16B token][4B 0]
        controlLink = new Socket();
        controlLink.connect(new InetSocketAddress(nodeAddr, tunnelPort), 8000);
        controlLink.setTcpNoDelay(true);
        controlOut = controlLink.getOutputStream();
        controlOut.write(handshake(LINK_CONTROL, 0));
        controlOut.flush();

        Thread reader = new Thread(this::readControlLink, "lanlink-ctl-link");
        reader.setDaemon(true);
        reader.start();

        // UDP 隧道
        udp = new UdpBridge(new InetSocketAddress(nodeAddr, tunnelPort), roomToken, gamePort);
        udp.start();
    }

    private byte[] handshake(byte type, int connId){
        byte[] h = new byte[25];
        System.arraycopy(MAGIC, 0, h, 0, 4);
        h[4] = type;
        System.arraycopy(roomToken, 0, h, 5, 16);
        h[21] = (byte)(connId >>> 24);
        h[22] = (byte)(connId >>> 16);
        h[23] = (byte)(connId >>> 8);
        h[24] = (byte)connId;
        return h;
    }

    private void readControlLink(){
        try(BufferedReader in = new BufferedReader(new InputStreamReader(controlLink.getInputStream(), StandardCharsets.UTF_8))){
            String line;
            while((line = in.readLine()) != null){
                Jval j = Jval.read(line);
                String op = j.getString("op", "");
                switch(op){
                    case "new_conn" -> onNewConn(j.getInt("id", -1), j.getString("addr", "?"));
                    case "conn_closed" -> {
                        TcpBridge b = bridges.remove(j.getInt("id", -1));
                        if(b != null) b.close();
                        notifyUi();
                    }
                    case "ping" -> sendControlLink("{\"op\":\"pong\"}");
                    default -> {}
                }
            }
        }catch(Throwable t){
            if(state == State.OPEN) fail("隧道控制链断开");
        }
    }

    private synchronized void sendControlLink(String line){
        try{
            controlOut.write((line + "\n").getBytes(StandardCharsets.UTF_8));
            controlOut.flush();
        }catch(Throwable t){
            Log.err("[LanLink] control link send", t);
        }
    }

    private void onNewConn(int id, String addr){
        Log.info("[LanLink] guest connecting: @ (conn @)", addr, id);
        // M1：自动放行（审批开关 M2+）
        sendControlLink("{\"op\":\"accept_conn\",\"id\":" + id + "}");
        Thread t = new Thread(() -> {
            try{
                Socket data = new Socket();
                data.connect(new InetSocketAddress(nodeAddr, tunnelPort), 8000);
                data.setTcpNoDelay(true);
                OutputStream out = data.getOutputStream();
                out.write(handshake(LINK_DATA, id));
                out.flush();

                Socket game = new Socket();
                game.connect(new InetSocketAddress("127.0.0.1", gamePort), 5000);
                game.setTcpNoDelay(true);

                TcpBridge bridge = new TcpBridge(data, game);
                bridge.onClosed = () -> {
                    bridges.remove(id);
                    notifyUi();
                };
                bridges.put(id, bridge);
                bridge.start(id);
                notifyUi();
            }catch(Throwable e){
                Log.err("[LanLink] data link " + id + " failed", e);
            }
        }, "lanlink-data-open-" + id);
        t.setDaemon(true);
        t.start();
    }

    public synchronized void close(){
        if(state == State.IDLE) return;
        if(control != null && control.isOpen()){
            Jval c = Jval.newObject();
            c.put("op", "close_room");
            control.send(c);
        }
        cleanup();
        setState(State.IDLE, "已关闭");
    }

    private void fail(String msg){
        Log.warn("[LanLink] " + msg);
        cleanup();
        setState(State.ERROR, msg);
    }

    private void cleanup(){
        for(TcpBridge b : bridges.values()) b.close();
        bridges.clear();
        if(udp != null){ udp.close(); udp = null; }
        if(portMapper != null){ portMapper.close(); portMapper = null; }
        synchronized(activeHolePunchers){
            for(HolePuncher h : activeHolePunchers) h.stop();
            activeHolePunchers.clear();
        }
        directCandidates = new ArrayList<>();
        try{ if(controlLink != null) controlLink.close(); }catch(Throwable ignored){}
        controlLink = null;
        if(control != null){ control.close(); control = null; }
        roomCode = "";
        publicAddr = "";
        directPublicAddr = "";
        displayName = "";
        nodeName = "";
        directStatusText = "";
        pendingSelectedNodeId = "";
        pendingManualRelayAddr = "";
        pendingManualRelayTunnelPort = 0;
        pendingToken = "";
        pendingPublicRoom = false;
    }

    /** 房主侧：收到客人候选后启动双向打洞（响应客人探测 + 主动探测客人） */
    private void startHostHolePunch(List<HolePuncher.CandidateAddress> guestCandidates){
        if(roomToken == null) return;
        HolePuncher puncher = new HolePuncher();
        synchronized(activeHolePunchers){ activeHolePunchers.add(puncher); }
        puncher.start(guestCandidates, roomToken, new HolePuncher.Callback(){
            @Override
            public void onSuccess(String addr, int port){
                Log.info("[LanLink] host hole-punch success with guest @:@", addr, port);
                synchronized(activeHolePunchers){ activeHolePunchers.remove(puncher); }
            }
            @Override
            public void onFailed(){
                Log.info("[LanLink] host hole-punch with guest failed, guest will fallback to relay");
                synchronized(activeHolePunchers){ activeHolePunchers.remove(puncher); }
            }
        });
    }

    private void setState(State s, String text){
        state = s;
        statusText = text;
        notifyUi();
    }

    private void notifyUi(){
        Core.app.post(onStateChanged);
    }

    private static byte[] hexToBytes(String hex){
        byte[] out = new byte[hex.length() / 2];
        for(int i = 0; i < out.length; i++){
            out[i] = (byte)Integer.parseInt(hex.substring(i * 2, i * 2 + 2), 16);
        }
        return out;
    }
}
