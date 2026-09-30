package lanlink.ui;

import arc.Core;
import arc.scene.ui.ScrollPane;
import arc.scene.ui.layout.Table;
import arc.util.Align;
import arc.util.Log;
import lanlink.auth.AuthSession;
import lanlink.auth.AuthStore;
import lanlink.net.ControlPlaneApi;
import mindustry.Vars;

import java.util.ArrayList;
import java.util.List;

/**
 * 好友面板 UI 组件。在 LanLinkDialog 中以 tab 或折叠区域嵌入。
 * 显示好友列表、在线状态、邀请按钮，以及待处理好友请求。
 */
public class FriendsPanel{
    private final LanLinkDialog dialog;
    private Table root;
    private Table friendsListTable;
    private Table requestsTable;
    private boolean loadingFriends;
    private boolean loadingRequests;
    private List<ControlPlaneApi.FriendInfo> friends = new ArrayList<>();
    private List<ControlPlaneApi.FriendRequestInfo> requests = new ArrayList<>();

    public FriendsPanel(LanLinkDialog dialog){
        this.dialog = dialog;
    }

    public Table build(){
        root = new Table();
        root.defaults().pad(4);

        // 标题行 + 刷新
        root.table(header -> {
            header.defaults().pad(4);
            header.add("好友").left().padRight(8);
            header.button(loadingFriends ? "刷新中…" : "刷新", this::refresh).size(90f, 40f)
                .disabled(b -> loadingFriends);
        }).fillX().row();

        // 好友列表（ScrollPane）
        friendsListTable = new Table();
        friendsListTable.defaults().fillX().pad(2);
        ScrollPane scroll = new ScrollPane(friendsListTable);
        scroll.setFadeScrollBars(true);
        root.add(scroll).fillX().maxHeight(260f).row();

        // 待处理请求
        requestsTable = new Table();
        requestsTable.defaults().fillX().pad(2);
        root.add("待处理好友请求:").left().padTop(6).row();
        root.add(requestsTable).fillX().row();

        refresh();
        return root;
    }

    public void refresh(){
        AuthSession session = AuthStore.load();
        if(!session.loggedIn){
            friends.clear();
            requests.clear();
            rebuildFriendsList();
            rebuildRequestsList();
            return;
        }

        String controlUrl = dialog.controlUrlPublic();
        String token = session.token;

        loadingFriends = true;
        ControlPlaneApi.fetchFriends(controlUrl, token, result -> {
            loadingFriends = false;
            if(result.ok){
                friends = new ArrayList<>(result.friends);
            }else{
                Log.warn("[LanLink] fetch friends: " + result.message);
            }
            rebuildFriendsList();
        });

        loadingRequests = true;
        ControlPlaneApi.fetchFriendRequests(controlUrl, token, result -> {
            loadingRequests = false;
            if(result.ok){
                requests = new ArrayList<>(result.requests);
            }else{
                Log.warn("[LanLink] fetch friend requests: " + result.message);
            }
            rebuildRequestsList();
        });
    }

    private void rebuildFriendsList(){
        if(friendsListTable == null) return;
        friendsListTable.clear();

        AuthSession session = AuthStore.load();
        if(!session.loggedIn){
            friendsListTable.add("[lightgray]请先登录后查看好友").pad(8).row();
            return;
        }

        if(loadingFriends){
            friendsListTable.add("[lightgray]加载中…").pad(8).row();
            return;
        }

        if(friends.isEmpty()){
            friendsListTable.add("[lightgray]暂无好友，可在论坛添加").pad(8).row();
            return;
        }

        for(ControlPlaneApi.FriendInfo friend : friends){
            friendsListTable.table(row -> {
                row.defaults().pad(4);
                // 头像占位（首字母）
                String initial = friend.username.isEmpty() ? "?" : String.valueOf(friend.username.charAt(0)).toUpperCase();
                row.add("[accent]" + initial).size(32f).padRight(4);
                // 用户名 + 状态
                String statusText = presenceLabel(friend.presenceStatus, friend.roomName);
                row.add(friend.username + "\n[lightgray]" + statusText).left().growX();
                // 邀请按钮（仅当自己已开房 + 好友在线时）
                if(dialog.isHostingRoom() && isOnline(friend.presenceStatus)){
                    row.button("邀请", () -> sendInvite(friend)).size(70f, 36f);
                }
            }).fillX().row();
        }
    }

    private void rebuildRequestsList(){
        if(requestsTable == null) return;
        requestsTable.clear();

        AuthSession session = AuthStore.load();
        if(!session.loggedIn){
            return;
        }

        if(loadingRequests){
            requestsTable.add("[lightgray]加载中…").pad(8).row();
            return;
        }

        if(requests.isEmpty()){
            requestsTable.add("[lightgray]暂无待处理请求").pad(8).row();
            return;
        }

        for(ControlPlaneApi.FriendRequestInfo req : requests){
            requestsTable.table(row -> {
                row.defaults().pad(4);
                row.add(req.requesterUsername).left().growX();
                row.add("[lightgray](" + req.createdAt + ")").left();
            }).fillX().row();
        }
    }

    private String presenceLabel(String status, String roomName){
        if(status == null) return "⚫ 离线";
        switch(status){
            case "online": return "🟢 在线";
            case "hosting":
                return "🎮 开房中" + (roomName.isEmpty() ? "" : "（" + roomName + "）");
            case "playing": return "👥 游戏中";
            case "offline": return "⚫ 离线";
            default: return status;
        }
    }

    private boolean isOnline(String status){
        return "online".equals(status) || "hosting".equals(status) || "playing".equals(status);
    }

    private void sendInvite(ControlPlaneApi.FriendInfo friend){
        AuthSession session = AuthStore.load();
        if(!session.loggedIn){
            Vars.ui.showInfo("请先登录");
            return;
        }
        String roomCode = dialog.currentRoomCode();
        if(roomCode == null || roomCode.isEmpty()){
            Vars.ui.showInfo("请先开放联机");
            return;
        }
        String controlUrl = dialog.controlUrlPublic();
        ControlPlaneApi.sendInvite(controlUrl, session.token, roomCode, friend.id, result -> {
            if(result.ok){
                Vars.ui.showInfoFade("已向 " + friend.username + " 发送邀请");
            }else{
                Vars.ui.showInfo(result.message);
            }
        });
    }
}
