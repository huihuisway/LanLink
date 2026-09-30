package lanlink;

import arc.Events;
import arc.scene.ui.layout.Table;
import arc.util.Log;
import lanlink.tunnel.TunnelManager;
import lanlink.ui.LanLinkDialog;
import mindustry.Vars;
import mindustry.game.EventType.ClientLoadEvent;
import mindustry.game.EventType.HostEvent;
import mindustry.mod.Mod;

public class LanLinkMod extends Mod{
    public static TunnelManager tunnel;
    public static LanLinkDialog dialog;

    public LanLinkMod(){
        Log.info("[LanLink] mod constructed");
    }

    @Override
    public void init(){
        if(Vars.headless) return;

        tunnel = new TunnelManager();

        Events.on(ClientLoadEvent.class, e -> {
            dialog = new LanLinkDialog(tunnel);
            injectUi();
            Log.info("[LanLink] initialized, game build @", Compat.gameBuild());
        });

        // 退出房间/停止 host 时收尾
        Events.on(mindustry.game.EventType.StateChangeEvent.class, e -> {
            if(tunnel != null && tunnel.state() != TunnelManager.State.IDLE && !Vars.net.server()){
                tunnel.close();
            }
        });
    }

    private void injectUi(){
        injectMainMenuButton();

        // 对话框内容可能在每次打开时重建，因此在 shown 回调里"查重后补挂"，而非启动时一次性注入
        try{
            Vars.ui.host.shown(() -> {
                try{
                    if(Vars.ui.host.buttons.find("lanlink-btn") == null){
                        var cell = Vars.ui.host.buttons.button("LanLink", () -> dialog.showHostMode());
                        cell.size(150f, 64f);
                        cell.get().name = "lanlink-btn";
                        Log.info("[LanLink] host dialog button injected");
                    }
                }catch(Throwable t){
                    Log.err("[LanLink] host dialog inject failed", t);
                }
            });
        }catch(Throwable t){
            Log.err("[LanLink] host dialog hook failed", t);
        }

        // 兜底入口：暂停菜单（已在开房状态时补一行 LanLink 按钮）
        try{
            Vars.ui.paused.shown(() -> {
                try{
                    if(Vars.ui.paused.cont.find("lanlink-btn") == null){
                        Vars.ui.paused.cont.row();
                        var cell = Vars.ui.paused.cont.button("LanLink 联机", () -> dialog.showHostMode());
                        cell.colspan(2).fillX().height(60f);
                        cell.get().name = "lanlink-btn";
                        Log.info("[LanLink] paused menu button injected");
                    }
                }catch(Throwable t){
                    Log.err("[LanLink] paused menu inject failed", t);
                }
            });
        }catch(Throwable t){
            Log.err("[LanLink] paused menu hook failed", t);
        }

        // 开房事件后主动提示一次
        Events.on(HostEvent.class, e -> {
            if(tunnel.state() == TunnelManager.State.IDLE){
                Vars.ui.showInfoFade("已开放主机，可打开 LanLink 面板一键联机");
            }
        });
    }

    private void injectMainMenuButton(){
        try{
            if(Vars.ui.menuGroup.find("lanlink-main-btn") != null) return;

            Table table = new Table();
            table.name = "lanlink-main-btn";
            table.setFillParent(true);
            table.bottom().left().margin(18f);
            table.visible(() -> Vars.state.isMenu());
            table.button("LanLink 联机", () -> dialog.showJoinMode()).size(190f, 58f);
            Vars.ui.menuGroup.addChild(table);

            // 仍注册到 menufrag 的自定义按钮列表，兼容重新构建主页菜单的情况。
            Vars.ui.menufrag.addButton("LanLink 联机", () -> dialog.showJoinMode());
            Log.info("[LanLink] main menu button injected");
        }catch(Throwable t){
            Log.err("[LanLink] main menu inject failed", t);
        }
    }
}
