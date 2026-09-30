package lanlink.net;

import arc.Core;
import arc.func.Cons;
import arc.util.Log;
import arc.util.serialization.Jval;
import lanlink.auth.AuthSession;
import lanlink.util.JsonUtils;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * 开房前的控制面 HTTP 查询（如可用节点列表）。
 * 与 TunnelManager 的 WS 状态机分离，避免把配置期逻辑塞进开房生命周期。
 */
public final class ControlPlaneApi{

    private ControlPlaneApi(){
    }

    public static final class NodeInfo{
        public final String id, name, addr, access, reason;
        public final int tunnelPort, rooms, sessions;
        public final double mbpsUsed;
        public volatile long latencyMs = -1L;
        public final boolean requiresLogin, usable;
        // M2 社区节点字段
        public final boolean official;
        public final String owner;
        public final String description;

        public NodeInfo(String id, String name, String addr, int tunnelPort, int rooms, int sessions, double mbpsUsed,
                        String access, boolean requiresLogin, boolean usable, String reason,
                        boolean official, String owner, String description){
            this.id = id;
            this.name = name;
            this.addr = addr;
            this.tunnelPort = tunnelPort;
            this.rooms = rooms;
            this.sessions = sessions;
            this.mbpsUsed = mbpsUsed;
            this.access = access;
            this.requiresLogin = requiresLogin;
            this.usable = usable;
            this.reason = reason;
            this.official = official;
            this.owner = owner == null ? "" : owner;
            this.description = description == null ? "" : description;
        }
    }

    public static final class FetchResult{
        public final boolean ok, supported;
        public final String message;
        public final List<NodeInfo> nodes;

        public FetchResult(boolean ok, boolean supported, String message, List<NodeInfo> nodes){
            this.ok = ok;
            this.supported = supported;
            this.message = message;
            this.nodes = nodes;
        }
    }

    public static final class DirectCandidateInfo{
        public final String mode, addr;
        public final int port;

        public DirectCandidateInfo(String mode, String addr, int port){
            this.mode = mode;
            this.addr = addr;
            this.port = port;
        }
    }

    public static final class RoomInfo{
        public final String code, name, displayName, nodeId, nodeName, nodeAddr, directAddr;
        public final int roomPort, directPort;
        public final boolean hasDirect;
        // M2：多个直连候选（按优先级排序）
        public final List<DirectCandidateInfo> directCandidates;

        public RoomInfo(String code, String name, String displayName, String nodeId, String nodeName, String nodeAddr, int roomPort,
                        boolean hasDirect, String directAddr, int directPort, List<DirectCandidateInfo> directCandidates){
            this.code = code;
            this.name = name;
            this.displayName = displayName;
            this.nodeId = nodeId;
            this.nodeName = nodeName;
            this.nodeAddr = nodeAddr;
            this.roomPort = roomPort;
            this.hasDirect = hasDirect;
            this.directAddr = directAddr;
            this.directPort = directPort;
            this.directCandidates = directCandidates == null ? Collections.emptyList() : directCandidates;
        }
    }

    public static final class FetchRoomResult{
        public final boolean ok, supported;
        public final String message;
        public final RoomInfo room;

        public FetchRoomResult(boolean ok, boolean supported, String message, RoomInfo room){
            this.ok = ok;
            this.supported = supported;
            this.message = message;
            this.room = room;
        }
    }

    public static final class AuthResult{
        public final boolean ok;
        public final String message;
        public final AuthSession session;

        public AuthResult(boolean ok, String message, AuthSession session){
            this.ok = ok;
            this.message = message;
            this.session = session;
        }
    }

    public static final class FriendInfo{
        public final String id, username, avatarUrl;
        public final String presenceStatus;
        public final String roomCode, roomName;

        public FriendInfo(String id, String username, String avatarUrl,
                          String presenceStatus, String roomCode, String roomName){
            this.id = id == null ? "" : id;
            this.username = username == null ? "" : username;
            this.avatarUrl = avatarUrl == null ? "" : avatarUrl;
            this.presenceStatus = presenceStatus == null ? "offline" : presenceStatus;
            this.roomCode = roomCode == null ? "" : roomCode;
            this.roomName = roomName == null ? "" : roomName;
        }
    }

    public static final class FriendsResult{
        public final boolean ok;
        public final String message;
        public final List<FriendInfo> friends;

        public FriendsResult(boolean ok, String message, List<FriendInfo> friends){
            this.ok = ok;
            this.message = message;
            this.friends = friends;
        }
    }

    public static final class FriendRequestInfo{
        public final String id, requesterId, requesterUsername, requesterAvatarUrl;
        public final String createdAt;

        public FriendRequestInfo(String id, String requesterId, String requesterUsername,
                                 String requesterAvatarUrl, String createdAt){
            this.id = id == null ? "" : id;
            this.requesterId = requesterId == null ? "" : requesterId;
            this.requesterUsername = requesterUsername == null ? "" : requesterUsername;
            this.requesterAvatarUrl = requesterAvatarUrl == null ? "" : requesterAvatarUrl;
            this.createdAt = createdAt == null ? "" : createdAt;
        }
    }

    public static final class FriendRequestsResult{
        public final boolean ok;
        public final String message;
        public final List<FriendRequestInfo> requests;

        public FriendRequestsResult(boolean ok, String message, List<FriendRequestInfo> requests){
            this.ok = ok;
            this.message = message;
            this.requests = requests;
        }
    }

    public static final class SimpleResult{
        public final boolean ok;
        public final String message;

        public SimpleResult(boolean ok, String message){
            this.ok = ok;
            this.message = message;
        }
    }

    public static final class RespondInviteResult{
        public final boolean ok;
        public final String message;
        public final String roomCode, roomName, nodeAddr;
        public final int roomPort, tunnelPort;

        public RespondInviteResult(boolean ok, String message, String roomCode, String roomName,
                                   String nodeAddr, int roomPort, int tunnelPort){
            this.ok = ok;
            this.message = message;
            this.roomCode = roomCode == null ? "" : roomCode;
            this.roomName = roomName == null ? "" : roomName;
            this.nodeAddr = nodeAddr == null ? "" : nodeAddr;
            this.roomPort = roomPort;
            this.tunnelPort = tunnelPort;
        }
    }

    public static final class VersionInfo{
        public final String latest, min, url;
        public final List<String> allowedModVersions;

        public VersionInfo(String latest, String min, String url, List<String> allowedModVersions){
            this.latest = latest == null ? "" : latest;
            this.min = min == null ? "" : min;
            this.url = url == null ? "" : url;
            this.allowedModVersions = allowedModVersions == null ? Collections.emptyList() : allowedModVersions;
        }
    }

    public static final class VersionResult{
        public final boolean ok;
        public final String message;
        public final VersionInfo version;

        public VersionResult(boolean ok, String message, VersionInfo version){
            this.ok = ok;
            this.message = message;
            this.version = version;
        }
    }

    public static void fetchVersion(String controlUrl, Cons<VersionResult> done){
        Thread t = new Thread(() -> {
            VersionResult result = fetchVersionBlocking(controlUrl);
            Core.app.post(() -> done.get(result));
        }, "lanlink-version-check");
        t.setDaemon(true);
        t.start();
    }

    private static VersionResult fetchVersionBlocking(String controlUrl){
        String apiUrl = normalizeHttpBase(controlUrl) + "/api/version";
        try{
            Map<String, String> headers = new HashMap<>();
            headers.put("Accept", "application/json");
            HttpResponse resp = httpGet(apiUrl, headers);
            if(resp.statusCode < 200 || resp.statusCode >= 300){
                return new VersionResult(false, "获取版本信息失败（HTTP " + resp.statusCode + "）", null);
            }
            return parseVersionJson(resp.body);
        }catch(Throwable t){
            Log.err("[LanLink] fetch version failed", t);
            return new VersionResult(false, "获取版本信息失败: " + t.getMessage(), null);
        }
    }

    private static VersionResult parseVersionJson(String body){
        try{
            Jval root = Jval.read(body);
            String latest = root.getString("latest", "");
            String min = root.getString("min", "");
            String url = root.getString("url", "");

            List<String> allowedVersions = new ArrayList<>();
            Jval allowedArr = root.get("allowed_mod_versions");
            if(allowedArr != null && allowedArr.isArray()){
                for(Jval v : allowedArr.asArray()){
                    String version = v.asString();
                    if(version != null && !version.isEmpty()){
                        allowedVersions.add(version);
                    }
                }
            }

            VersionInfo info = new VersionInfo(latest, min, url, allowedVersions);
            return new VersionResult(true, "已获取版本信息", info);
        }catch(Throwable t){
            Log.err("[LanLink] parse version failed", t);
            return new VersionResult(false, "版本信息解析失败: " + t.getMessage(), null);
        }
    }

    public static void fetchAvailableNodes(String controlUrl, String token, Cons<FetchResult> done){
        Thread t = new Thread(() -> {
            FetchResult result = fetchAvailableNodesBlocking(controlUrl, token);
            Core.app.post(() -> done.get(result));
        }, "lanlink-node-list");
        t.setDaemon(true);
        t.start();
    }

    public static void fetchAvailableNodes(String controlUrl, Cons<FetchResult> done){
        fetchAvailableNodes(controlUrl, "", done);
    }

    public static void loginWithCode(String controlUrl, String code, Cons<AuthResult> done){
        Thread t = new Thread(() -> {
            AuthResult result = loginWithCodeBlocking(controlUrl, code);
            Core.app.post(() -> done.get(result));
        }, "lanlink-login-code");
        t.setDaemon(true);
        t.start();
    }

    public static void loginWithCredentials(String controlUrl, String username, String password,
                                           Cons<UsernamePasswordAuth.LoginResult> done){
        Thread t = new Thread(() -> {
            UsernamePasswordAuth.LoginResult result = UsernamePasswordAuth.login(controlUrl, username, password);
            Core.app.post(() -> done.get(result));
        }, "lanlink-login-credentials");
        t.setDaemon(true);
        t.start();
    }

    public static void fetchRoom(String controlUrl, String roomCode, Cons<FetchRoomResult> done){
        Thread t = new Thread(() -> {
            FetchRoomResult result = fetchRoomBlocking(controlUrl, roomCode);
            Core.app.post(() -> done.get(result));
        }, "lanlink-room-lookup");
        t.setDaemon(true);
        t.start();
    }

    public static void startDeviceAuth(String controlUrl, Cons<DeviceAuth.StartResult> done){
        Thread t = new Thread(() -> {
            DeviceAuth.StartResult result = DeviceAuth.start(controlUrl);
            Core.app.post(() -> done.get(result));
        }, "lanlink-device-auth-start");
        t.setDaemon(true);
        t.start();
    }

    public static void pollDeviceAuth(String controlUrl, String sessionId, Cons<DeviceAuth.PollResult> done){
        Thread t = new Thread(() -> {
            DeviceAuth.PollResult result = DeviceAuth.poll(controlUrl, sessionId);
            Core.app.post(() -> done.get(result));
        }, "lanlink-device-auth-poll");
        t.setDaemon(true);
        t.start();
    }

    public static void fetchFriends(String controlUrl, String token, Cons<FriendsResult> done){
        Thread t = new Thread(() -> {
            FriendsResult result = fetchFriendsBlocking(controlUrl, token);
            Core.app.post(() -> done.get(result));
        }, "lanlink-friends");
        t.setDaemon(true);
        t.start();
    }

    public static void fetchFriendRequests(String controlUrl, String token, Cons<FriendRequestsResult> done){
        Thread t = new Thread(() -> {
            FriendRequestsResult result = fetchFriendRequestsBlocking(controlUrl, token);
            Core.app.post(() -> done.get(result));
        }, "lanlink-friend-requests");
        t.setDaemon(true);
        t.start();
    }

    public static void sendInvite(String controlUrl, String token, String roomCode,
                                  String friendUserId, Cons<SimpleResult> done){
        Thread t = new Thread(() -> {
            SimpleResult result = sendInviteBlocking(controlUrl, token, roomCode, friendUserId);
            Core.app.post(() -> done.get(result));
        }, "lanlink-send-invite");
        t.setDaemon(true);
        t.start();
    }

    public static void respondInvite(String controlUrl, String token, String roomCode,
                                     String action, Cons<RespondInviteResult> done){
        Thread t = new Thread(() -> {
            RespondInviteResult result = respondInviteBlocking(controlUrl, token, roomCode, action);
            Core.app.post(() -> done.get(result));
        }, "lanlink-respond-invite");
        t.setDaemon(true);
        t.start();
    }

    private static FetchResult fetchAvailableNodesBlocking(String controlUrl, String token){
        String apiUrl = normalizeHttpBase(controlUrl) + "/api/nodes/available";
        try{
            Map<String, String> headers = new HashMap<>();
            headers.put("Accept", "application/json");
            if(token != null && !token.isEmpty()) headers.put("Authorization", "Bearer " + token);
            HttpResponse resp = httpGet(apiUrl, headers);
            if(resp.statusCode == 404){
                return new FetchResult(false, false, "该控制面暂不支持节点列表，可直接开放联机自动选点", Collections.emptyList());
            }
            if(resp.statusCode >= 400){
                String errorMsg = parseErrorMessage(resp.body);
                String userMsg = errorMsg.isEmpty()
                    ? "读取节点列表失败（HTTP " + resp.statusCode + "）"
                    : lanlink.util.ErrorMessage.friendly(errorMsg);
                return new FetchResult(false, true, userMsg, Collections.emptyList());
            }
            return parseNodesJson(resp.body);
        }catch(Throwable t){
            Log.err("[LanLink] fetch nodes failed", t);
            return new FetchResult(false, true, lanlink.util.ErrorMessage.friendly(t.getMessage()), Collections.emptyList());
        }
    }

    private static FetchResult parseNodesJson(String body){
        try{
            Jval root = Jval.read(body);
            Jval nodes = root.get("nodes");
            if(nodes == null){
                return new FetchResult(false, true, "控制面返回格式不正确", Collections.emptyList());
            }
            List<NodeInfo> out = new ArrayList<>();
            for(Jval node : nodes.asArray()){
                String id = node.getString("id", "");
                out.add(new NodeInfo(
                    id,
                    node.getString("name", id),
                    node.getString("addr", ""),
                    node.getInt("tunnel_port", 0),
                    node.getInt("rooms", 0),
                    node.getInt("sessions", 0),
                    node.getDouble("mbps_used", 0d),
                    node.getString("access", "anonymous"),
                    node.getBool("requires_login", false),
                    node.getBool("usable", true),
                    node.getString("reason", ""),
                    node.getBool("official", true),
                    node.getString("owner", ""),
                    node.getString("description", "")
                ));
            }
            return new FetchResult(true, true,
                out.isEmpty() ? "当前控制面没有在线中继" : "已加载 " + out.size() + " 个中继节点",
                out);
        }catch(Throwable t){
            Log.err("[LanLink] parse nodes failed", t);
            return new FetchResult(false, true, "控制面返回解析失败: " + t.getMessage(), Collections.emptyList());
        }
    }

    private static AuthResult loginWithCodeBlocking(String controlUrl, String quickCode){
        String codeText = quickCode == null ? "" : quickCode.trim().toUpperCase();
        if(codeText.isEmpty()) return new AuthResult(false, "请先输入论坛识别码", AuthSession.anonymous());

        String apiUrl = normalizeHttpBase(controlUrl) + "/api/auth/code/exchange";
        try{
            Map<String, String> headers = new HashMap<>();
            headers.put("Accept", "application/json");
            headers.put("Content-Type", "application/json; charset=utf-8");
            String payload = "{\"code\":\"" + JsonUtils.escapeJson(codeText) + "\"}";
            byte[] body = payload.getBytes(StandardCharsets.UTF_8);
            HttpResponse resp = httpPost(apiUrl, headers, body);
            if(resp.statusCode < 200 || resp.statusCode >= 300){
                String message = "登录失败（HTTP " + resp.statusCode + "）";
                try{
                    Jval err = Jval.read(resp.body);
                    message = err.getString("message", message);
                }catch(Throwable ignored){}
                return new AuthResult(false, message, AuthSession.anonymous());
            }
            return parseLoginJson(resp.body);
        }catch(Throwable t){
            Log.err("[LanLink] login failed", t);
            return new AuthResult(false, "登录失败: " + t.getMessage(), AuthSession.anonymous());
        }
    }

    private static AuthResult parseLoginJson(String body){
        try{
            Jval root = Jval.read(body);
            if(!root.getBool("ok", false)) return new AuthResult(false, root.getString("message", "登录失败"), AuthSession.anonymous());
            Jval user = root.get("user");
            if(user == null) return new AuthResult(false, "控制面返回格式不正确", AuthSession.anonymous());
            AuthSession session = new AuthSession(
                root.getString("token", ""),
                user.getString("username", ""),
                user.getString("display_name", user.getString("username", "")),
                user.getString("role", "")
            );
            if(!session.loggedIn) return new AuthResult(false, "控制面返回登录态不完整", AuthSession.anonymous());
            return new AuthResult(true, "已登录为 " + session.displayName, session);
        }catch(Throwable t){
            Log.err("[LanLink] parse login failed", t);
            return new AuthResult(false, "控制面返回解析失败: " + t.getMessage(), AuthSession.anonymous());
        }
    }

    private static FetchRoomResult fetchRoomBlocking(String controlUrl, String roomCode){
        String codeText = roomCode == null ? "" : roomCode.trim().toUpperCase();
        if(codeText.isEmpty()) return new FetchRoomResult(false, true, "请先输入房间码", null);

        String apiUrl = normalizeHttpBase(controlUrl) + "/api/rooms/" + encodePathPart(codeText);
        try{
            Map<String, String> headers = new HashMap<>();
            headers.put("Accept", "application/json");
            HttpResponse resp = httpGet(apiUrl, headers);
            if(resp.statusCode == 404){
                return new FetchRoomResult(false, true, "房间不存在或已关闭", null);
            }
            if(resp.statusCode >= 400){
                String errorMsg = parseErrorMessage(resp.body);
                String userMsg = errorMsg.isEmpty()
                    ? "读取房间失败（HTTP " + resp.statusCode + "）"
                    : lanlink.util.ErrorMessage.friendly(errorMsg);
                return new FetchRoomResult(false, true, userMsg, null);
            }
            return parseRoomJson(resp.body, codeText);
        }catch(Throwable t){
            Log.err("[LanLink] fetch room failed", t);
            return new FetchRoomResult(false, true, lanlink.util.ErrorMessage.friendly(t.getMessage()), null);
        }
    }

    private static FetchRoomResult parseRoomJson(String body, String codeText){
        try{
            Jval root = Jval.read(body);
            Jval node = root.get("node");
            if(node == null){
                return new FetchRoomResult(false, true, "控制面返回格式不正确", null);
            }

            String nodeAddr = node.getString("addr", "");
            int roomPort = node.getInt("room_port", 0);
            if(nodeAddr.isEmpty() || roomPort <= 0){
                return new FetchRoomResult(false, true, "房间地址不完整，请稍后重试", null);
            }

            String nodeId = node.getString("id", "");
            Jval direct = root.get("direct");
            String directAddr = "";
            int directPort = 0;
            boolean hasDirect = false;
            if(direct != null){
                directAddr = direct.getString("addr", "");
                directPort = direct.getInt("port", 0);
                hasDirect = !directAddr.isEmpty() && directPort > 0 && directPort <= 65535;
            }

            // M2：解析 direct_candidates 数组
            List<DirectCandidateInfo> directCandidatesList = new ArrayList<>();
            Jval candidatesArr = root.get("direct_candidates");
            if(candidatesArr != null){
                for(Jval c : candidatesArr.asArray()){
                    String addr = c.getString("addr", "");
                    int port = c.getInt("port", 0);
                    if(!addr.isEmpty() && port > 0 && port <= 65535){
                        directCandidatesList.add(new DirectCandidateInfo(c.getString("mode", ""), addr, port));
                    }
                }
            }
            // 如果 direct_candidates 为空但 direct 存在，用 direct 填充
            if(directCandidatesList.isEmpty() && hasDirect){
                directCandidatesList.add(new DirectCandidateInfo("", directAddr, directPort));
            }

            RoomInfo room = new RoomInfo(
                root.getString("code", codeText),
                root.getString("name", ""),
                root.getString("display_name", ""),
                nodeId,
                node.getString("name", nodeId),
                nodeAddr,
                roomPort,
                hasDirect,
                hasDirect ? directAddr : "",
                hasDirect ? directPort : 0,
                directCandidatesList
            );
            return new FetchRoomResult(true, true, "已解析房间 " + room.code, room);
        }catch(Throwable t){
            Log.err("[LanLink] parse room failed", t);
            return new FetchRoomResult(false, true, "控制面返回解析失败: " + t.getMessage(), null);
        }
    }

    private static FriendsResult fetchFriendsBlocking(String controlUrl, String token){
        if(token == null || token.isEmpty()){
            return new FriendsResult(false, "请先登录", Collections.emptyList());
        }
        String apiUrl = normalizeHttpBase(controlUrl) + "/api/friends";
        try{
            Map<String, String> headers = new HashMap<>();
            headers.put("Accept", "application/json");
            headers.put("Authorization", "Bearer " + token);
            HttpResponse resp = httpGet(apiUrl, headers);
            if(resp.statusCode >= 400){
                String errorMsg = parseErrorMessage(resp.body);
                String userMsg = errorMsg.isEmpty()
                    ? "读取好友列表失败（HTTP " + resp.statusCode + "）"
                    : lanlink.util.ErrorMessage.friendly(errorMsg);
                return new FriendsResult(false, userMsg, Collections.emptyList());
            }
            return parseFriendsJson(resp.body);
        }catch(Throwable t){
            Log.err("[LanLink] fetch friends failed", t);
            return new FriendsResult(false, lanlink.util.ErrorMessage.friendly(t.getMessage()), Collections.emptyList());
        }
    }

    private static FriendsResult parseFriendsJson(String body){
        try{
            Jval root = Jval.read(body);
            if(!root.getBool("ok", false)){
                return new FriendsResult(false, root.getString("message", "读取好友列表失败"), Collections.emptyList());
            }
            Jval friends = root.get("friends");
            List<FriendInfo> out = new ArrayList<>();
            if(friends != null){
                for(Jval f : friends.asArray()){
                    Jval presence = f.get("presence");
                    String presenceStatus = "offline";
                    String roomCode = "";
                    String roomName = "";
                    if(presence != null){
                        presenceStatus = presence.getString("status", "offline");
                        roomCode = presence.getString("room_code", "");
                        roomName = presence.getString("room_name", "");
                    }
                    out.add(new FriendInfo(
                        f.getString("id", ""),
                        f.getString("username", ""),
                        f.getString("avatar_url", ""),
                        presenceStatus,
                        roomCode,
                        roomName
                    ));
                }
            }
            return new FriendsResult(true, "已加载 " + out.size() + " 位好友", out);
        }catch(Throwable t){
            Log.err("[LanLink] parse friends failed", t);
            return new FriendsResult(false, "好友列表解析失败: " + t.getMessage(), Collections.emptyList());
        }
    }

    private static FriendRequestsResult fetchFriendRequestsBlocking(String controlUrl, String token){
        if(token == null || token.isEmpty()){
            return new FriendRequestsResult(false, "请先登录", Collections.emptyList());
        }
        String apiUrl = normalizeHttpBase(controlUrl) + "/api/friends/requests";
        try{
            Map<String, String> headers = new HashMap<>();
            headers.put("Accept", "application/json");
            headers.put("Authorization", "Bearer " + token);
            HttpResponse resp = httpGet(apiUrl, headers);
            if(resp.statusCode >= 400){
                String errorMsg = parseErrorMessage(resp.body);
                String userMsg = errorMsg.isEmpty()
                    ? "读取好友请求失败（HTTP " + resp.statusCode + "）"
                    : lanlink.util.ErrorMessage.friendly(errorMsg);
                return new FriendRequestsResult(false, userMsg, Collections.emptyList());
            }
            return parseFriendRequestsJson(resp.body);
        }catch(Throwable t){
            Log.err("[LanLink] fetch friend requests failed", t);
            return new FriendRequestsResult(false, lanlink.util.ErrorMessage.friendly(t.getMessage()), Collections.emptyList());
        }
    }

    private static FriendRequestsResult parseFriendRequestsJson(String body){
        try{
            Jval root = Jval.read(body);
            if(!root.getBool("ok", false)){
                return new FriendRequestsResult(false, root.getString("message", "读取好友请求失败"), Collections.emptyList());
            }
            Jval requests = root.get("requests");
            List<FriendRequestInfo> out = new ArrayList<>();
            if(requests != null){
                for(Jval r : requests.asArray()){
                    Jval requester = r.get("requester");
                    out.add(new FriendRequestInfo(
                        r.getString("id", ""),
                        requester != null ? requester.getString("id", "") : "",
                        requester != null ? requester.getString("username", "") : "",
                        requester != null ? requester.getString("avatar_url", "") : "",
                        r.getString("created_at", "")
                    ));
                }
            }
            return new FriendRequestsResult(true, "已加载 " + out.size() + " 个好友请求", out);
        }catch(Throwable t){
            Log.err("[LanLink] parse friend requests failed", t);
            return new FriendRequestsResult(false, "好友请求解析失败: " + t.getMessage(), Collections.emptyList());
        }
    }

    private static SimpleResult sendInviteBlocking(String controlUrl, String token, String roomCode, String friendUserId){
        if(token == null || token.isEmpty()){
            return new SimpleResult(false, "请先登录");
        }
        String apiUrl = normalizeHttpBase(controlUrl) + "/api/invites/send";
        try{
            Map<String, String> headers = new HashMap<>();
            headers.put("Accept", "application/json");
            headers.put("Content-Type", "application/json; charset=utf-8");
            headers.put("Authorization", "Bearer " + token);
            String payload = "{\"room_code\":\"" + JsonUtils.escapeJson(roomCode) + "\",\"friend_user_id\":\"" + JsonUtils.escapeJson(friendUserId) + "\"}";
            byte[] body = payload.getBytes(StandardCharsets.UTF_8);
            HttpResponse resp = httpPost(apiUrl, headers, body);
            if(resp.statusCode >= 400){
                String errorMsg = parseErrorMessage(resp.body);
                String userMsg = errorMsg.isEmpty()
                    ? "发送邀请失败（HTTP " + resp.statusCode + "）"
                    : lanlink.util.ErrorMessage.friendly(errorMsg);
                return new SimpleResult(false, userMsg);
            }
            return new SimpleResult(true, "邀请已发送");
        }catch(Throwable t){
            Log.err("[LanLink] send invite failed", t);
            return new SimpleResult(false, "发送邀请失败: " + t.getMessage());
        }
    }

    private static RespondInviteResult respondInviteBlocking(String controlUrl, String token, String roomCode, String action){
        if(token == null || token.isEmpty()){
            return new RespondInviteResult(false, "请先登录", "", "", "", 0, 0);
        }
        String apiUrl = normalizeHttpBase(controlUrl) + "/api/invites/respond";
        try{
            Map<String, String> headers = new HashMap<>();
            headers.put("Accept", "application/json");
            headers.put("Content-Type", "application/json; charset=utf-8");
            headers.put("Authorization", "Bearer " + token);
            String payload = "{\"room_code\":\"" + JsonUtils.escapeJson(roomCode) + "\",\"action\":\"" + JsonUtils.escapeJson(action) + "\"}";
            byte[] body = payload.getBytes(StandardCharsets.UTF_8);
            HttpResponse resp = httpPost(apiUrl, headers, body);
            if(resp.statusCode >= 400){
                String errorMsg = parseErrorMessage(resp.body);
                String userMsg = errorMsg.isEmpty()
                    ? "响应邀请失败（HTTP " + resp.statusCode + "）"
                    : lanlink.util.ErrorMessage.friendly(errorMsg);
                return new RespondInviteResult(false, userMsg, "", "", "", 0, 0);
            }
            return parseRespondInviteJson(resp.body, action);
        }catch(Throwable t){
            Log.err("[LanLink] respond invite failed", t);
            return new RespondInviteResult(false, lanlink.util.ErrorMessage.friendly(t.getMessage()), "", "", "", 0, 0);
        }
    }

    private static RespondInviteResult parseRespondInviteJson(String body, String action){
        try{
            Jval root = Jval.read(body);
            if(!root.getBool("ok", false)){
                return new RespondInviteResult(false, root.getString("message", "响应邀请失败"), "", "", "", 0, 0);
            }
            if("accept".equals(action)){
                Jval room = root.get("room");
                if(room == null){
                    return new RespondInviteResult(false, "控制面返回格式不正确", "", "", "", 0, 0);
                }
                Jval node = room.get("node");
                String nodeAddr = "";
                int roomPort = 0;
                int tunnelPort = 0;
                if(node != null){
                    nodeAddr = node.getString("addr", "");
                    roomPort = node.getInt("room_port", 0);
                    tunnelPort = node.getInt("tunnel_port", 0);
                }
                return new RespondInviteResult(
                    true, "已接受邀请",
                    room.getString("code", ""),
                    room.getString("name", ""),
                    nodeAddr, roomPort, tunnelPort
                );
            }
            return new RespondInviteResult(true, "已拒绝邀请", "", "", "", 0, 0);
        }catch(Throwable t){
            Log.err("[LanLink] parse respond invite failed", t);
            return new RespondInviteResult(false, "控制面返回解析失败: " + t.getMessage(), "", "", "", 0, 0);
        }
    }

    /**
     * 跨平台 HTTP GET。Android 走 SimpleHttpClient（raw socket，绕过 cleartext 限制）；
     * 桌面走 HttpURLConnection。
     */
    static HttpResponse httpGet(String url, Map<String, String> headers) throws Exception{
        if(Core.app.isAndroid()){
            SimpleHttpClient.Response r = SimpleHttpClient.request("GET", url, headers, null);
            return new HttpResponse(r.statusCode, r.body);
        }
        HttpURLConnection conn = null;
        try{
            conn = (HttpURLConnection)new URL(url).openConnection();
            conn.setConnectTimeout(8000);
            conn.setReadTimeout(8000);
            conn.setRequestMethod("GET");
            if(headers != null){
                for(Map.Entry<String, String> e : headers.entrySet()){
                    conn.setRequestProperty(e.getKey(), e.getValue());
                }
            }
            int code = conn.getResponseCode();
            String body = readText(code >= 200 && code < 300 ? conn.getInputStream() : conn.getErrorStream());
            return new HttpResponse(code, body);
        }finally{
            if(conn != null) conn.disconnect();
        }
    }

    static HttpResponse httpPost(String url, Map<String, String> headers, byte[] body) throws Exception{
        if(Core.app.isAndroid()){
            SimpleHttpClient.Response r = SimpleHttpClient.request("POST", url, headers, body);
            return new HttpResponse(r.statusCode, r.body);
        }
        HttpURLConnection conn = null;
        try{
            conn = (HttpURLConnection)new URL(url).openConnection();
            conn.setConnectTimeout(8000);
            conn.setReadTimeout(8000);
            conn.setRequestMethod("POST");
            conn.setDoOutput(true);
            if(headers != null){
                for(Map.Entry<String, String> e : headers.entrySet()){
                    conn.setRequestProperty(e.getKey(), e.getValue());
                }
            }
            if(body != null){
                conn.setRequestProperty("Content-Length", String.valueOf(body.length));
                try(OutputStream out = conn.getOutputStream()){
                    out.write(body);
                }
            }
            int code = conn.getResponseCode();
            String text = readText(code >= 200 && code < 300 ? conn.getInputStream() : conn.getErrorStream());
            return new HttpResponse(code, text);
        }finally{
            if(conn != null) conn.disconnect();
        }
    }

    /**
     * 跨平台 HTTP GET，用于协议探测（短超时，不读 body）。
     * 桌面用 HttpURLConnection（原生支持 HTTPS）；Android 用 SimpleHttpClient（也已支持 HTTPS）。
     */
    private static boolean probeHttps(String host){
        String url = "https://" + host + "/api/health";
        try{
            if(Core.app.isAndroid()){
                SimpleHttpClient.Response r = SimpleHttpClient.request("GET", url, null, null);
                // 任何 HTTP 响应（包括 404）都说明 HTTPS 可用
                return r.statusCode > 0;
            }
            HttpURLConnection conn = null;
            try{
                conn = (HttpURLConnection)new URL(url).openConnection();
                conn.setConnectTimeout(3000);
                conn.setReadTimeout(3000);
                conn.setRequestMethod("GET");
                // 触发连接 + 读状态码
                int code = conn.getResponseCode();
                return code > 0;
            }finally{
                if(conn != null) conn.disconnect();
            }
        }catch(Throwable t){
            // SSL 握手失败、连接超时、连接拒绝等都说明 HTTPS 不可用
            return false;
        }
    }

    /**
     * 裸域名协议自动探测（HTTPS 优先），结果缓存到 schemeCache。
     * 仅在后台线程的阻塞方法中调用，不会阻塞 UI 线程。
     */
    private static String detectScheme(String bareHost){
        String cached = schemeCache.get(bareHost);
        if(cached != null) return cached;

        String scheme = probeHttps(bareHost) ? "https" : "http";
        schemeCache.put(bareHost, scheme);
        Log.info("[LanLink] 协议探测 " + bareHost + " → " + scheme);
        return scheme;
    }

    /** 协议探测结果缓存：host → "http" 或 "https" */
    private static final ConcurrentHashMap<String, String> schemeCache = new ConcurrentHashMap<>();

    /** 统一的 HTTP 响应结构 */
    static final class HttpResponse{
        final int statusCode;
        final String body;
        HttpResponse(int statusCode, String body){
            this.statusCode = statusCode;
            this.body = body == null ? "" : body;
        }
    }

    public static String normalizeHttpBase(String controlUrl){
        String base = normalizeBase(controlUrl);
        if(base.startsWith("ws://")) return "http://" + base.substring(5);
        if(base.startsWith("wss://")) return "https://" + base.substring(6);
        if(base.startsWith("http://") || base.startsWith("https://")) return base;
        // 裸域名：自动探测 HTTPS/HTTP（在后台线程阻塞调用，安全）
        String scheme = detectScheme(base);
        return scheme + "://" + base;
    }

    public static String normalizeWebSocketBase(String controlUrl){
        String base = normalizeBase(controlUrl);
        if(base.startsWith("http://")) return "ws://" + base.substring(7);
        if(base.startsWith("https://")) return "wss://" + base.substring(8);
        if(base.startsWith("ws://") || base.startsWith("wss://")) return base;
        // 裸域名：查缓存（由之前的 normalizeHttpBase 调用填充），不阻塞
        String cached = schemeCache.get(base);
        if(cached != null){
            return ("https".equals(cached) ? "wss://" : "ws://") + base;
        }
        // 无缓存则默认 ws://（保持原有行为）
        return "ws://" + base;
    }

    private static String normalizeBase(String controlUrl){
        String base = controlUrl == null ? "" : controlUrl.trim();
        while(base.endsWith("/")){
            base = base.substring(0, base.length() - 1);
        }
        if(base.endsWith("/ws/mod")) return base.substring(0, base.length() - 7);
        if(base.endsWith("/ws/node")) return base.substring(0, base.length() - 8);
        return base;
    }

    private static String encodePathPart(String value){
        try{
            return URLEncoder.encode(value, "UTF-8").replace("+", "%20");
        }catch(Throwable ignored){
            return value;
        }
    }

    private static String readText(InputStream stream) throws Exception{
        if(stream == null) return "";
        try(BufferedReader reader = new BufferedReader(new InputStreamReader(stream, StandardCharsets.UTF_8))){
            StringBuilder sb = new StringBuilder();
            String line;
            while((line = reader.readLine()) != null){
                if(sb.length() > 0) sb.append('\n');
                sb.append(line);
            }
            return sb.toString();
        }
    }

    /**
     * 解析服务器返回的错误消息。
     * 服务器通常返回 {"message": "..."} 格式的错误信息。
     *
     * @param body 响应体
     * @return 错误消息，如果解析失败返回空字符串
     */
    private static String parseErrorMessage(String body){
        if(body == null || body.isEmpty()) return "";
        try{
            Jval root = Jval.read(body);
            return root.getString("message", "");
        }catch(Throwable ignored){
            return "";
        }
    }
}
