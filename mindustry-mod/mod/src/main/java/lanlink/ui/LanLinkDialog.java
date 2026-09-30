package lanlink.ui;

import arc.Core;
import arc.util.Align;
import arc.util.Log;
import arc.util.Timer;
import lanlink.auth.AuthSession;
import lanlink.auth.AuthStore;
import lanlink.net.ControlPlaneApi;
import lanlink.net.DeviceAuth;
import lanlink.net.HolePuncher;
import lanlink.net.NodeSelector;
import lanlink.net.UsernamePasswordAuth;
import lanlink.tunnel.TunnelManager;
import mindustry.Vars;
import mindustry.ui.dialogs.BaseDialog;

import java.util.ArrayList;
import java.util.List;

/**
 * LanLink 主对话框：开放/关闭联机、公网地址与房间码展示、状态。
 */
public class LanLinkDialog extends BaseDialog{
    private static final String DEFAULT_CONTROL_URL = "ll.mdtbbs.cn";
    private static final String SETTING_CONTROL_URL = "lanlink-control-url";
    private static final String SETTING_SELECT_MODE = "lanlink-node-select-mode";
    private static final String SETTING_SELECTED_NODE_ID = "lanlink-selected-node-id";
    private static final String SETTING_MANUAL_ADDR = "lanlink-manual-relay-addr";
    private static final String SETTING_MANUAL_PORT = "lanlink-manual-relay-port";
    private static final String SETTING_PANEL_MODE = "lanlink-panel-mode";
    private static final String SETTING_ROOM_CODE = "lanlink-room-code";
    private static final String SETTING_ENABLE_DIRECT = "lanlink-enable-direct";
    private static final String SETTING_QUICK_CODE = "lanlink-auth-quick-code";
    private static final String SETTING_USERNAME = "lanlink-auth-username";
    private static final String SETTING_PASSWORD = "lanlink-auth-password";
    private static final String SETTING_PUBLIC_ROOM = "lanlink-public-room";

    private final TunnelManager tunnel;
    private List<ControlPlaneApi.NodeInfo> cachedNodes = new ArrayList<>();
    private boolean loadingNodes;
    private boolean loggingIn;
    private boolean refreshingAuth;
    private boolean nodesSupported = true;
    private boolean joiningRoom;
    private int joinAttemptSeq;
    private boolean joinOnly;
    private String nodeStatus = "可刷新控制面节点列表";
    private String authStatus = "使用论坛账号登录";
    private String joinStatus = "输入房间码后加入联机";
    private String loadedControlUrl = "";

    // rebuild 节流：合并 100ms 内的多次状态变化，避免频繁重建 UI
    private long lastRebuildTime = 0;
    private static final long REBUILD_THROTTLE_MS = 100;
    private Runnable pendingRebuild = null;

    // 好友面板
    private FriendsPanel friendsPanel;
    private FriendsDialog friendsDialog;

    // 折叠区
    private boolean advancedExpanded = false;

    // 网络诊断
    private boolean diagnosing = false;
    private lanlink.net.NetworkDiagnostics.DiagnosticResult diagnosticResult = null;

    // 版本信息
    private ControlPlaneApi.VersionInfo versionInfo = null;
    private boolean checkingVersion = false;

    private enum SelectMode{list, manual}
    private enum PanelMode{host, join}

    public LanLinkDialog(TunnelManager tunnel){
        super("LanLink 联机");
        this.tunnel = tunnel;
        tunnel.onStateChanged = this::throttledRebuild;
        tunnel.onInviteReceived = this::showInvitePopup;
        friendsPanel = new FriendsPanel(this);
        friendsDialog = new FriendsDialog(friendsPanel);
        shown(() -> {
            rebuild();
            checkVersion();
            if(AuthStore.load().loggedIn && cachedNodes.isEmpty() && !loadingNodes) refreshNodes();
        });
        addCloseButton();
        rebuild();
    }

    public void showHostMode(){
        joinOnly = false;
        setPanelMode(PanelMode.host);
        show();
    }

    public void showJoinMode(){
        joinOnly = true;
        setPanelMode(PanelMode.join);
        show();
    }

    private void rebuild(){
        cont.clear();
        cont.defaults().pad(6);

        TunnelManager.State st = tunnel.state();

        cont.add("状态: " + tunnel.statusText).row();
        if(!tunnel.directStatusText.isEmpty()){
            cont.add("直连状态: [accent]" + tunnel.directStatusText).width(520f).wrap().labelAlign(Align.center).row();
        }

        // 版本信息
        if(versionInfo != null){
            String currentVersion = lanlink.BuildInfo.MOD_VERSION;
            String versionText = "Mod 版本: " + currentVersion;
            if(!versionInfo.latest.isEmpty() && !currentVersion.equals(versionInfo.latest)){
                versionText += "  [yellow](最新: " + versionInfo.latest + ")";
            }
            cont.add("[lightgray]" + versionText).width(520f).wrap().labelAlign(Align.center).row();
        }

        if(st == TunnelManager.State.OPEN){
            buildOpenState();
        }else if(st == TunnelManager.State.CONNECTING){
            cont.add("连接中…").row();
        }else if(st == TunnelManager.State.ERROR){
            cont.add("[red]" + tunnel.statusText).width(520f).wrap().labelAlign(Align.center).row();
            cont.button("重试", () -> tunnel.retry()).size(160f, 50f).row();
            cont.button("返回", () -> {
                tunnel.retry();  // 先切到 IDLE
                rebuild();
            }).size(160f, 50f).row();
        }else{
            if(!joinOnly) buildModeTabs();
            buildIdleState();
        }
    }

    /**
     * 节流的 rebuild：100ms 内多次调用只 rebuild 一次。
     * 用于合并频繁的状态变化（如直连发现进度更新）。
     * 仅在调用线程为 Mindustry 主线程时安全（TunnelManager 已通过 Core.app.post 切换）。
     */
    private void throttledRebuild(){
        long now = System.currentTimeMillis();
        long elapsed = now - lastRebuildTime;

        if(elapsed >= REBUILD_THROTTLE_MS){
            // 已超过节流间隔，立即 rebuild
            lastRebuildTime = now;
            rebuild();
        }else if(pendingRebuild == null){
            // 在节流间隔内且尚未调度延迟 rebuild：安排一次延迟执行
            float delaySec = (REBUILD_THROTTLE_MS - elapsed) / 1000f;
            pendingRebuild = () -> {
                lastRebuildTime = System.currentTimeMillis();
                pendingRebuild = null;
                rebuild();
            };
            Timer.schedule(pendingRebuild, delaySec);
        }
        // 若 pendingRebuild 已非 null，说明已有一次延迟 rebuild 排队，无需重复调度
    }

    private void buildModeTabs(){
        cont.table(t -> {
            t.defaults().pad(4).minWidth(180f);
            t.button(panelMode() == PanelMode.host ? "[accent]开房" : "开房", () -> {
                setPanelMode(PanelMode.host);
                rebuild();
            }).size(170f, 50f);
            t.button(panelMode() == PanelMode.join ? "[accent]输入房间码" : "输入房间码", () -> {
                setPanelMode(PanelMode.join);
                rebuild();
            }).size(170f, 50f);
        }).row();
    }

    private void buildOpenState(){
        // 显示房间码（主要信息）
        cont.add("房间码: [accent]" + tunnel.roomCode).row();

        // 显示联机标识（如果有）
        if(!tunnel.displayName.isEmpty()){
            cont.add("联机标识:").row();
            cont.add(tunnel.displayName).width(420f).wrap().labelAlign(Align.center).row();
        }

        // 显示节点名称（可选，用户友好信息）
        if(!tunnel.nodeName.isEmpty()) cont.add("中继节点: [accent]" + tunnel.nodeName).row();

        cont.add("在线客人: " + tunnel.guestCount()).row();

        // 复制按钮：仅复制房间码
        cont.button("复制房间码", () -> {
            Core.app.setClipboardText(tunnel.roomCode);
            Vars.ui.showInfoFade("已复制房间码");
        }).size(200f, 54f).row();

        // 复制完整信息（包含房间码和标识）
        cont.button("复制房间信息", () -> {
            String text = "房间码: " + tunnel.roomCode;
            if(!tunnel.displayName.isEmpty()){
                text = (tunnel.displayName.isEmpty() ? "LanLink 联机" : tunnel.displayName)
                    + "\n房间码: " + tunnel.roomCode;
            }
            Core.app.setClipboardText(text);
            Vars.ui.showInfoFade("已复制房间信息");
        }).size(200f, 54f).row();

        cont.button("关闭联机", () -> {
            tunnel.close();
            rebuild();
        }).size(200f, 54f).row();
    }

    private void buildIdleState(){
        if(panelMode() == PanelMode.join){
            buildJoinState();
            return;
        }

        if(!Vars.net.server()){
            cont.add("[lightgray]请先在游戏中「开放主机」，再开启 LanLink 联机").width(420f).wrap().labelAlign(Align.center).row();
        }

        buildAuthState();

        if(AuthStore.load().loggedIn){
            cont.button("好友", () -> friendsDialog.show()).size(140f, 44f).row();
        }
        cont.check("将房间公开到论坛（默认关闭）", publicRoomEnabled(), enabled -> {
            Core.settings.put(SETTING_PUBLIC_ROOM, enabled);
            rebuild();
        }).left().row();
        cont.add("[lightgray]关闭时房间和房间码都不会出现在论坛在线房间列表").width(520f).wrap().labelAlign(Align.center).row();

        cont.add("[lightgray]" + nodeStatus).width(520f).wrap().labelAlign(Align.center).row();

        cont.button(loadingNodes ? "正在选择最佳节点…" : "快速开房", this::openRoom)
            .disabled(b -> !Vars.net.server() || !AuthStore.load().loggedIn || !AuthStore.load().phoneVerified || !canOpenInCurrentMode())
            .size(220f, 58f).row();

        cont.button(advancedExpanded ? "收起高级设置" : "高级设置", () -> {
            advancedExpanded = !advancedExpanded;
            rebuild();
        }).size(150f, 42f).row();
        if(advancedExpanded) buildAdvancedHostSettings();
    }

    private void buildAdvancedHostSettings(){
        cont.table(t -> {
            t.defaults().left().pad(4);
            t.button(loadingNodes ? "刷新中…" : "重新测速选点", this::refreshNodes).disabled(b -> loadingNodes).size(160f, 48f);
            t.button(diagnosing ? "测试中…" : "测试控制面", this::testConnection).disabled(b -> diagnosing).size(150f, 48f);
        }).row();
        if(diagnosticResult != null){
            cont.add((diagnosticResult.ok ? "[green]✓ " : "[yellow]✗ ") + diagnosticResult.message)
                .width(520f).wrap().labelAlign(Align.center).row();
        }
        cont.check("优先直连（失败自动中继）", directEnabled(), enabled -> {
            Core.settings.put(SETTING_ENABLE_DIRECT, enabled);
            rebuild();
        }).left().row();
        cont.table(modes -> {
            modes.button(currentMode() == SelectMode.list ? "[accent]自动/列表选择" : "自动/列表选择", () -> {
                setMode(SelectMode.list);
                rebuild();
            }).size(190f, 46f);
            modes.button(currentMode() == SelectMode.manual ? "[accent]手动中继" : "手动中继", () -> {
                setMode(SelectMode.manual);
                rebuild();
            }).size(150f, 46f);
        }).row();
        if(currentMode() == SelectMode.list) buildNodeListMode();
        else buildManualMode();
    }

    private void buildAuthState(){
        AuthSession session = AuthStore.load();
        if(session.loggedIn){
            cont.table(t -> {
                t.defaults().pad(4);
                // 头像占位
                String initial = session.displayName.isEmpty() ? "?" : String.valueOf(session.displayName.charAt(0)).toUpperCase();
                t.add("[accent]" + initial).size(32f).padRight(4);
                t.add("论坛账号: [accent]" + session.displayName + " [lightgray](" + session.role + ")").left().width(360f);
                t.button("退出", () -> {
                    AuthStore.clear();
                    authStatus = "已退出论坛账号";
                    // 清空密码字段
                    Core.settings.put(SETTING_PASSWORD, "");
                    refreshNodes();
                    rebuild();
                }).size(90f, 44f);
            }).row();
            if(session.phoneVerified){
                cont.add("[green]✓ 手机号已验证").row();
            }else{
                cont.add("[yellow]该论坛账号尚未验证手机号，完成验证后请点击刷新")
                    .width(520f).wrap().labelAlign(Align.center).row();
                cont.button(refreshingAuth ? "刷新中…" : "刷新验证状态", this::refreshAuthStatus)
                    .disabled(b -> refreshingAuth).size(180f, 44f).row();
            }
        }else{
            // 未登录：用户名密码登录表单
            cont.table(t -> {
                t.defaults().pad(4);
                t.add("用户名: ");
                t.field(username(), s -> Core.settings.put(SETTING_USERNAME, s.trim()))
                    .width(200f).maxTextLength(64);
                t.row();
                t.add("密码: ");
                t.field(password(), s -> Core.settings.put(SETTING_PASSWORD, s))
                    .width(200f).maxTextLength(128);
                t.row();
                t.button(loggingIn ? "登录中…" : "登录", this::loginWithCredentials)
                    .disabled(b -> loggingIn || username().isEmpty() || password().isEmpty())
                    .size(120f, 44f).colspan(2);
            }).row();

            cont.add("[lightgray]使用论坛账号登录；登录后可使用更多中继节点和好友功能")
                .width(520f).wrap().labelAlign(Align.center).row();
        }
        cont.add("[lightgray]登录状态: " + authStatus).width(520f).wrap().labelAlign(Align.center).row();
    }

    private String username(){
        return Core.settings.getString(SETTING_USERNAME, "").trim();
    }

    private String password(){
        return Core.settings.getString(SETTING_PASSWORD, "");
    }

    private void loginWithCredentials(){
        String user = username();
        String pass = password();
        if(user.isEmpty() || pass.isEmpty() || loggingIn) return;

        loggingIn = true;
        authStatus = "正在登录…";
        rebuild();

        ControlPlaneApi.loginWithCredentials(controlUrl(), user, pass, result -> {
            loggingIn = false;
            if(result.ok){
                AuthStore.save(result.session);
                authStatus = "已登录为 " + result.session.displayName;
                // 登录成功后立即清空密码
                Core.settings.put(SETTING_PASSWORD, "");
                Vars.ui.showInfoFade("已登录为 " + result.session.displayName);
                refreshNodes();
            }else{
                authStatus = result.message;
                Vars.ui.showInfo(result.message);
            }
            rebuild();
        });
    }

    private void refreshAuthStatus(){
        AuthSession current = AuthStore.load();
        if(!current.loggedIn || refreshingAuth) return;
        refreshingAuth = true;
        authStatus = "正在刷新论坛验证状态…";
        rebuild();
        Thread t = new Thread(() -> {
            UsernamePasswordAuth.LoginResult result = UsernamePasswordAuth.refresh(controlUrl(), current.token);
            Core.app.post(() -> {
                refreshingAuth = false;
                if(result.ok){
                    AuthStore.save(result.session);
                    authStatus = result.session.phoneVerified ? "手机号验证已同步" : "论坛仍显示手机号未验证";
                    if(result.session.phoneVerified){
                        Vars.ui.showInfoFade("验证成功，现在可以联机");
                        refreshNodes();
                    }
                }else{
                    authStatus = result.message;
                    Vars.ui.showInfo(result.message);
                }
                rebuild();
            });
        }, "lanlink-refresh-auth");
        t.setDaemon(true);
        t.start();
    }

    private void buildJoinState(){
        if(Vars.net.server()){
            cont.add("[yellow]当前正在作为房主运行；若要加入别人的房间，请先退出本地开房").width(520f).wrap().labelAlign(Align.center).row();
        }
        if(Vars.net.client()){
            cont.add("[yellow]当前已连接服务器；加入新房间会先断开现有连接").width(520f).wrap().labelAlign(Align.center).row();
        }

        cont.table(t -> {
            t.defaults().left().pad(4);
            t.button(loadingNodes ? "刷新中…" : "刷新节点", this::refreshNodes).disabled(b -> loadingNodes).size(130f, 54f);
        }).row();

        buildAuthState();

        cont.add("[lightgray]节点列表状态: " + nodeStatus).width(520f).wrap().labelAlign(Align.center).row();
        buildJoinNodeSummary();

        cont.table(t -> {
            t.defaults().left().pad(4);
            t.add("房间码: ");
            t.field(roomCode(), s -> Core.settings.put(SETTING_ROOM_CODE, normalizeRoomCodeInput(s))).width(240f);
        }).row();
        cont.add("[lightgray]" + joinStatus).width(520f).wrap().labelAlign(Align.center).row();

        cont.button(joiningRoom ? "加入中…" : "加入联机", this::joinRoom)
            .disabled(b -> joiningRoom || Vars.net.server() || !AuthStore.load().loggedIn || !AuthStore.load().phoneVerified || roomCode().isEmpty())
            .size(220f, 58f).row();
    }

    private void buildJoinNodeSummary(){
        if(loadedControlUrl.equals(controlUrl()) && !cachedNodes.isEmpty()){
            cont.add("可用中继节点:").row();
            for(ControlPlaneApi.NodeInfo node : cachedNodes){
                String label = (node.usable ? "[accent]" : "[yellow]") + node.name
                    + (node.usable ? "" : "（需登录）")
                    + " [lightgray](房间 " + node.rooms + ", 会话 " + node.sessions + ")";
                cont.add(label).width(520f).wrap().labelAlign(Align.center).row();
            }
        }
    }

    private void buildNodeListMode(){
        if(!nodesSupported){
            cont.add("[yellow]当前控制面不支持节点列表；继续开放联机时将由控制面自动选点").width(520f).wrap().labelAlign(Align.center).row();
            return;
        }
        if(!loadedControlUrl.equals(controlUrl())){
            cont.add("[lightgray]请先刷新当前控制面的节点列表").width(520f).wrap().labelAlign(Align.center).row();
            return;
        }
        if(cachedNodes.isEmpty()){
            cont.add("[lightgray]暂无已加载节点，点击上方“刷新中继列表”").width(520f).wrap().labelAlign(Align.center).row();
            return;
        }

        cont.add("选择一个控制面已注册的中继节点:").row();
        // 分组：官方节点优先显示
        boolean hasOfficial = false, hasCommunity = false;
        for(ControlPlaneApi.NodeInfo node : cachedNodes){
            if(node.official) hasOfficial = true;
            else hasCommunity = true;
        }
        if(hasOfficial) cont.add("[green]官方节点").left().row();
        for(ControlPlaneApi.NodeInfo node : cachedNodes){
            if(!node.official) continue;
            cont.button(nodeLabel(node), () -> {
                Core.settings.put(SETTING_SELECTED_NODE_ID, node.id);
                rebuild();
            }).disabled(b -> !node.usable).width(520f).height(54f).row();
        }
        if(hasCommunity){
            cont.add("[cyan]社区节点").left().row();
            for(ControlPlaneApi.NodeInfo node : cachedNodes){
                if(node.official) continue;
                cont.button(nodeLabel(node), () -> {
                    Core.settings.put(SETTING_SELECTED_NODE_ID, node.id);
                    rebuild();
                }).disabled(b -> !node.usable).width(520f).height(54f).row();
            }
        }
    }

    private String nodeLabel(ControlPlaneApi.NodeInfo node){
        String selected = selectedNodeId();
        String typeTag = node.official ? "" : "[cyan]社区" + (node.owner.isEmpty() ? "" : " · " + node.owner) + " ";
        String base = (node.id.equals(selected) ? "[accent]● " : "○ ") + typeTag + node.name
            + (node.usable ? "" : " [yellow](需登录)")
            + " [lightgray](" + (node.latencyMs >= 0 ? node.latencyMs + "ms, " : "")
            + "房间 " + node.rooms + ", 会话 " + node.sessions + ", " + node.mbpsUsed + "Mbps)";
        return base;
    }

    private void buildManualMode(){
        if(!nodesSupported){
            cont.add("[yellow]当前控制面不支持显式选点；继续开放联机时将由控制面自动选点").width(520f).wrap().labelAlign(Align.center).row();
            return;
        }
        cont.add("手动填写当前控制面名下的在线中继地址与隧道端口:").width(520f).wrap().labelAlign(Align.center).row();
        cont.table(t -> {
            t.defaults().left().pad(4);
            t.add("中继地址: ");
            t.field(Core.settings.getString(SETTING_MANUAL_ADDR, ""), s -> Core.settings.put(SETTING_MANUAL_ADDR, s.trim())).width(260f);
        }).row();
        cont.table(t -> {
            t.defaults().left().pad(4);
            t.add("隧道端口: ");
            t.field(Core.settings.getString(SETTING_MANUAL_PORT, ""), s -> Core.settings.put(SETTING_MANUAL_PORT, digitsOnly(s))).width(140f);
        }).row();
        cont.add("[lightgray]说明：这里不会绕过控制面，只会按地址/端口匹配当前控制面的在线节点").width(520f).wrap().labelAlign(Align.center).row();
    }

    // 设备授权和识别码登录已移除，统一使用用户名密码登录

    private void refreshNodes(){
        if(loadingNodes) return;
        loadingNodes = true;
        nodeStatus = "正在读取控制面节点列表…";
        rebuild();

        ControlPlaneApi.fetchAvailableNodes(controlUrl(), AuthStore.load().token, result -> {
            loadingNodes = false;
            nodesSupported = result.supported;
            nodeStatus = result.message;
            if(result.ok){
                loadedControlUrl = controlUrl();
                cachedNodes = new ArrayList<>(result.nodes);
                selectBestNodeAsync();
            }else if(!result.supported){
                loadedControlUrl = "";
                cachedNodes.clear();
            }
            rebuild();
        });
    }

    private void selectBestNodeAsync(){
        List<ControlPlaneApi.NodeInfo> snapshot = new ArrayList<>(cachedNodes);
        nodeStatus = "正在测量节点延迟并选择最佳节点…";
        Thread t = new Thread(() -> {
            try{
                ControlPlaneApi.NodeInfo best = NodeSelector.selectBest(snapshot);
                Core.app.post(() -> {
                    if(best != null && loadedControlUrl.equals(controlUrl())){
                        Core.settings.put(SETTING_SELECTED_NODE_ID, best.id);
                        nodeStatus = "已自动选择 " + best.name
                            + (best.latencyMs >= 0 ? "（" + best.latencyMs + "ms）" : "（延迟未知）");
                    }else{
                        ensureSelectedNodeStillExists();
                        nodeStatus = "未找到可用中继节点";
                    }
                    rebuild();
                });
            }catch(Throwable error){
                Log.err("LanLink failed to select a relay node", error);
                Core.app.post(() -> {
                    ensureSelectedNodeStillExists();
                    nodeStatus = "自动选择节点失败，请手动选择";
                    rebuild();
                });
            }
        }, "lanlink-node-selector");
        t.setDaemon(true);
        t.start();
    }

    private void testConnection(){
        if(diagnosing) return;
        diagnosing = true;
        diagnosticResult = null;
        rebuild();

        lanlink.net.NetworkDiagnostics.testControlPlaneAsync(controlUrl(), result -> {
            diagnosing = false;
            diagnosticResult = result;
            rebuild();

            if(result.ok){
                Vars.ui.showInfoFade("控制面连接正常（延迟 " + result.latencyMs + "ms）");
            }else{
                String message = result.message;
                if(!result.suggestion.isEmpty()){
                    message += "\n\n建议: " + result.suggestion;
                }
                Vars.ui.showInfo(message);
            }
        });
    }

    private void checkVersion(){
        if(checkingVersion || versionInfo != null) return;
        checkingVersion = true;

        ControlPlaneApi.fetchVersion(controlUrl(), result -> {
            checkingVersion = false;
            if(result.ok && result.version != null){
                versionInfo = result.version;
                rebuild();

                // 检查是否有更新
                String currentVersion = lanlink.BuildInfo.MOD_VERSION;
                if(!currentVersion.isEmpty() && !versionInfo.latest.isEmpty()
                    && !currentVersion.equals(versionInfo.latest)){
                    // 检查当前版本是否在允许列表中
                    if(!versionInfo.allowedModVersions.isEmpty()
                        && !versionInfo.allowedModVersions.contains(currentVersion)){
                        Vars.ui.showInfo("⚠ 当前 Mod 版本 " + currentVersion + " 不被支持\n" +
                            "请更新到: " + versionInfo.latest + "\n\n" +
                            "下载地址: " + versionInfo.url);
                    }
                }
            }
        });
    }

    private void ensureSelectedNodeStillExists(){
        String selected = selectedNodeId();
        if(selected.isEmpty()){
            selectFirstUsableNode();
            return;
        }
        for(ControlPlaneApi.NodeInfo node : cachedNodes){
            if(node.id.equals(selected) && node.usable) return;
        }
        selectFirstUsableNode();
    }

    private void selectFirstUsableNode(){
        for(ControlPlaneApi.NodeInfo node : cachedNodes){
            if(node.usable){
                Core.settings.put(SETTING_SELECTED_NODE_ID, node.id);
                return;
            }
        }
        Core.settings.put(SETTING_SELECTED_NODE_ID, "");
    }

    private boolean canOpenInCurrentMode(){
        if(currentMode() == SelectMode.list){
            if(!nodesSupported) return true;
            return loadedControlUrl.equals(controlUrl()) && !cachedNodes.isEmpty() && selectedNodeUsable();
        }
        return nodesSupported && !manualRelayAddr().isEmpty() && manualRelayTunnelPort() > 0;
    }

    private boolean selectedNodeUsable(){
        String selected = selectedNodeId();
        if(selected.isEmpty()) return false;
        for(ControlPlaneApi.NodeInfo node : cachedNodes){
            if(node.id.equals(selected)) return node.usable;
        }
        return false;
    }

    private void openRoom(){
        if(!Vars.net.server()){
            Vars.ui.showInfo("尚未开房：请先在暂停菜单「开放主机」");
            return;
        }
        AuthSession session = AuthStore.load();
        if(!session.loggedIn){
            Vars.ui.showInfo("请先登录后再开放联机");
            return;
        }
        if(!session.phoneVerified){
            Vars.ui.showInfo("请先在论坛完成手机号验证，然后刷新验证状态");
            return;
        }
        if(!canOpenInCurrentMode()){
            Vars.ui.showInfo("请先选择中继节点，或填写有效的中继地址与隧道端口");
            return;
        }

        TunnelManager.OpenOptions opts = new TunnelManager.OpenOptions();
        opts.controlUrl = ControlPlaneApi.normalizeWebSocketBase(controlUrl());
        opts.gamePort = Core.settings.getInt("lanlink-game-port", Vars.port);
        opts.roomName = Core.settings.getString("name", "player") + " 的房间";
        opts.enableDirect = directEnabled();
        opts.token = AuthStore.load().token;
        opts.publicRoom = publicRoomEnabled();
        if(currentMode() == SelectMode.list){
            if(nodesSupported) opts.selectedNodeId = selectedNodeId();
        }else{
            opts.manualRelayAddr = manualRelayAddr();
            opts.manualRelayTunnelPort = manualRelayTunnelPort();
        }
        tunnel.open(opts);
    }

    private void joinRoom(){
        if(joiningRoom) return;
        AuthSession session = AuthStore.load();
        if(!session.loggedIn){
            Vars.ui.showInfo("请先登录后再加入联机");
            return;
        }
        if(!session.phoneVerified){
            Vars.ui.showInfo("请先在论坛完成手机号验证，然后刷新验证状态");
            return;
        }
        if(Vars.net.server()){
            Vars.ui.showInfo("当前正在作为房主运行，不能加入其他房间");
            return;
        }

        String code = roomCode();
        if(code.isEmpty()){
            Vars.ui.showInfo("请先输入房间码");
            return;
        }

        joiningRoom = true;
        joinStatus = "正在解析房间码…";
        rebuild();

        ControlPlaneApi.fetchRoom(controlUrl(), code, result -> {
            if(result.ok && result.room != null){
                connectRoom(result.room);
            }else{
                joiningRoom = false;
                joinStatus = result.message;
                rebuild();
                Vars.ui.showInfo(result.message);
            }
        });
    }

    private void connectRoom(ControlPlaneApi.RoomInfo room){
        String label = roomLabel(room);
        // M2：优先尝试直连
        if(!room.directCandidates.isEmpty()){
            joinStatus = "直连探测 " + label + "（" + room.directCandidates.size() + " 个候选）…";
            rebuild();
            // 先做 UDP 打洞探测（5s），成功立即游戏连接；失败再依次尝试
            startHolePunchPhase(room);
        }else if(room.hasDirect){
            joinStatus = "正在尝试直连 " + label + " / " + room.directAddr + ":" + room.directPort + "…";
            rebuild();
            startJoinAttempt(room, room.directAddr, room.directPort, true);
        }else{
            joinStatus = "正在通过中继连接 " + label + " / " + relayLabel(room) + "…";
            rebuild();
            startJoinAttempt(room, room.nodeAddr, room.roomPort, false);
        }
    }

    private HolePuncher activeHolePuncher;

    /** 客人侧：先做 UDP 打洞探测，成功立即游戏连接；否则回退依次尝试 + 中继 */
    private void startHolePunchPhase(ControlPlaneApi.RoomInfo room){
        java.util.List<HolePuncher.CandidateAddress> addrs = new java.util.ArrayList<>();
        for(ControlPlaneApi.DirectCandidateInfo c : room.directCandidates){
            addrs.add(new HolePuncher.CandidateAddress(c.addr, c.port));
        }
        HolePuncher puncher = new HolePuncher();
        activeHolePuncher = puncher;
        puncher.start(addrs, new byte[16], new HolePuncher.Callback(){
            @Override
            public void onSuccess(String addr, int port){
                Core.app.post(() -> {
                    activeHolePuncher = null;
                    if(!joiningRoom) return;
                    joinStatus = "打洞成功，正在连接 " + addr + ":" + port + "…";
                    rebuild();
                    startJoinAttempt(room, addr, port, true, () -> startJoinAttemptCandidates(room, 0));
                });
            }
            @Override
            public void onFailed(){
                Core.app.post(() -> {
                    activeHolePuncher = null;
                    if(!joiningRoom) return;
                    joinStatus = "打洞未成功，依次尝试候选…";
                    rebuild();
                    startJoinAttemptCandidates(room, 0);
                });
            }
        });
    }

    /** 按顺序尝试 directCandidates 列表中的每个候选 */
    private void startJoinAttemptCandidates(ControlPlaneApi.RoomInfo room, int index){
        if(index >= room.directCandidates.size()){
            // 全部失败，回退中继
            joinStatus = "直连候选全部失败，回退中继 " + relayLabel(room) + "…";
            rebuild();
            startJoinAttempt(room, room.nodeAddr, room.roomPort, false);
            return;
        }
        ControlPlaneApi.DirectCandidateInfo c = room.directCandidates.get(index);
        joinStatus = "尝试直连 [" + (index + 1) + "/" + room.directCandidates.size() + "] " + c.mode + " " + c.addr + ":" + c.port + "…";
        rebuild();
        startJoinAttempt(room, c.addr, c.port, true, () -> startJoinAttemptCandidates(room, index + 1));
    }

    private void startJoinAttempt(ControlPlaneApi.RoomInfo room, boolean direct){
        // 兼容旧路径：单一直连候选
        startJoinAttempt(room, direct ? room.directAddr : room.nodeAddr,
            direct ? room.directPort : room.roomPort, direct, null);
    }

    private void startJoinAttempt(ControlPlaneApi.RoomInfo room, String addr, int port, boolean direct){
        startJoinAttempt(room, addr, port, direct, null);
    }

    private void startJoinAttempt(ControlPlaneApi.RoomInfo room, String addr, int port, boolean direct, Runnable onFail){
        int seq = ++joinAttemptSeq;
        if(Vars.net.client()) Vars.netClient.disconnectQuietly();
        Vars.ui.join.connect(addr, port);
        if(direct){
            Timer.schedule(() -> {
                if(seq != joinAttemptSeq || !joiningRoom) return;
                if(Vars.net.client() && Vars.state.isGame() && !Vars.netClient.isConnecting()){
                    joiningRoom = false;
                    joinStatus = "直连已连接";
                    rebuild();
                    return;
                }
                if(Vars.net.client()) Vars.netClient.disconnectQuietly();
                if(onFail != null){
                    onFail.run();
                }else{
                    joinStatus = "直连失败，正在回退中继 " + relayLabel(room) + "…";
                    rebuild();
                    startJoinAttempt(room, room.nodeAddr, room.roomPort, false);
                }
            }, 8f);
        }else{
            joiningRoom = false;
            Timer.schedule(() -> {
                if(seq == joinAttemptSeq && Vars.net.client() && Vars.state.isGame()){
                    joinStatus = "已通过中继连接";
                    rebuild();
                }
            }, 2f);
        }
    }

    private String roomLabel(ControlPlaneApi.RoomInfo room){
        String label = room.displayName.isEmpty() ? room.name : room.displayName;
        return label.isEmpty() ? room.code : label;
    }

    private String relayLabel(ControlPlaneApi.RoomInfo room){
        String node = room.nodeName.isEmpty() ? room.nodeAddr : room.nodeName;
        return node + ":" + room.roomPort;
    }

    private String controlUrl(){
        return DEFAULT_CONTROL_URL;
    }

    private SelectMode currentMode(){
        String raw = Core.settings.getString(SETTING_SELECT_MODE, SelectMode.list.name());
        return "manual".equals(raw) ? SelectMode.manual : SelectMode.list;
    }

    private PanelMode panelMode(){
        String raw = Core.settings.getString(SETTING_PANEL_MODE, PanelMode.host.name());
        return "join".equals(raw) ? PanelMode.join : PanelMode.host;
    }

    private void setPanelMode(PanelMode mode){
        Core.settings.put(SETTING_PANEL_MODE, mode.name());
    }

    private void setMode(SelectMode mode){
        Core.settings.put(SETTING_SELECT_MODE, mode.name());
    }

    private String selectedNodeId(){
        return Core.settings.getString(SETTING_SELECTED_NODE_ID, "").trim();
    }

    private String roomCode(){
        return Core.settings.getString(SETTING_ROOM_CODE, "").trim().toUpperCase();
    }

    private String manualRelayAddr(){
        return Core.settings.getString(SETTING_MANUAL_ADDR, "").trim();
    }

    private boolean directEnabled(){
        return Core.settings.getBool(SETTING_ENABLE_DIRECT, true);
    }

    private boolean publicRoomEnabled(){
        return Core.settings.getBool(SETTING_PUBLIC_ROOM, false);
    }

    private String quickCode(){
        return Core.settings.getString(SETTING_QUICK_CODE, "").trim().toUpperCase();
    }

    private int manualRelayTunnelPort(){
        try{
            return Integer.parseInt(Core.settings.getString(SETTING_MANUAL_PORT, "0").trim());
        }catch(Throwable ignored){
            return 0;
        }
    }

    private String digitsOnly(String value){
        StringBuilder out = new StringBuilder();
        for(int i = 0; i < value.length(); i++){
            char c = value.charAt(i);
            if(c >= '0' && c <= '9') out.append(c);
        }
        return out.toString();
    }

    private String normalizeQuickCodeInput(String value){
        StringBuilder out = new StringBuilder();
        for(int i = 0; i < value.length(); i++){
            char c = Character.toUpperCase(value.charAt(i));
            if((c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '-') out.append(c);
        }
        return out.toString();
    }

    private String normalizeRoomCodeInput(String value){
        StringBuilder out = new StringBuilder();
        for(int i = 0; i < value.length(); i++){
            char c = Character.toUpperCase(value.charAt(i));
            if((c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '-') out.append(c);
        }
        return out.toString();
    }

    // ---- 公共方法供 FriendsPanel 使用 ----

    /** 当前控制面地址（公开给 FriendsPanel） */
    public String controlUrlPublic(){
        return controlUrl();
    }

    /** 当前是否正在开房（房主状态） */
    public boolean isHostingRoom(){
        return tunnel.state() == TunnelManager.State.OPEN;
    }

    /** 当前房间码（开房时） */
    public String currentRoomCode(){
        return isHostingRoom() ? tunnel.roomCode : "";
    }

    // ---- 邀请弹窗 ----

    private void showInvitePopup(TunnelManager.InviteInfo info){
        String roomLabel = info.roomDisplayName.isEmpty() ? info.roomName : info.roomDisplayName;
        if(roomLabel.isEmpty()) roomLabel = info.roomCode;
        BaseDialog dialog = new BaseDialog("好友邀请");
        dialog.cont.add("【" + info.fromUsername + "】邀请你加入").pad(8).row();
        dialog.cont.add("[accent]" + roomLabel).pad(8).row();
        dialog.cont.add("[lightgray]房间码: " + info.roomCode).pad(4).row();
        dialog.cont.add("[lightgray]有效期: " + info.expiresIn + " 秒").pad(4).row();
        dialog.buttons.defaults().size(140f, 50f).pad(8);
        dialog.buttons.button("接受", () -> {
            dialog.hide();
            acceptInvite(info);
        });
        dialog.buttons.button("拒绝", () -> {
            dialog.hide();
            declineInvite(info);
        });
        dialog.buttons.button("稍后", dialog::hide);
        dialog.show();
    }

    private void acceptInvite(TunnelManager.InviteInfo info){
        AuthSession session = AuthStore.load();
        if(!session.loggedIn){
            Vars.ui.showInfo("请先登录");
            return;
        }
        ControlPlaneApi.respondInvite(controlUrl(), session.token, info.roomCode, "accept", result -> {
            if(result.ok){
                Vars.ui.showInfoFade("已接受邀请");
                // 自动执行 join 流程
                Core.app.post(() -> {
                    if(result.roomCode.isEmpty()){
                        // 控制面没有返回房间信息，手动查
                        ControlPlaneApi.fetchRoom(controlUrl(), info.roomCode, fetchResult -> {
                            if(fetchResult.ok && fetchResult.room != null){
                                setPanelMode(PanelMode.join);
                                Core.settings.put(SETTING_ROOM_CODE, fetchResult.room.code);
                                connectRoom(fetchResult.room);
                                rebuild();
                            }else{
                                Vars.ui.showInfo(fetchResult.message);
                            }
                        });
                    }else{
                        // 用返回的房间信息直接连接
                        ControlPlaneApi.RoomInfo room = new ControlPlaneApi.RoomInfo(
                            result.roomCode,
                            result.roomName,
                            "", "", "",
                            result.nodeAddr,
                            result.roomPort,
                            false, "", 0,
                            java.util.Collections.emptyList()
                        );
                        setPanelMode(PanelMode.join);
                        Core.settings.put(SETTING_ROOM_CODE, result.roomCode);
                        connectRoom(room);
                        rebuild();
                    }
                });
            }else{
                Vars.ui.showInfo(result.message);
            }
        });
    }

    private void declineInvite(TunnelManager.InviteInfo info){
        AuthSession session = AuthStore.load();
        if(!session.loggedIn) return;
        ControlPlaneApi.respondInvite(controlUrl(), session.token, info.roomCode, "decline", result -> {
            if(result.ok){
                Vars.ui.showInfoFade("已拒绝邀请");
            }else{
                Vars.ui.showInfo(result.message);
            }
        });
    }
}
