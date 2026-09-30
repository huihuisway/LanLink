package lanlink.ui;

import mindustry.ui.dialogs.BaseDialog;

/** Friends live outside the hosting flow so the quick-host screen stays focused. */
public class FriendsDialog extends BaseDialog{
    private final FriendsPanel panel;

    public FriendsDialog(FriendsPanel panel){
        super("LanLink 好友");
        this.panel = panel;
        shown(this::rebuild);
        addCloseButton();
    }

    private void rebuild(){
        cont.clear();
        cont.add(panel.build()).fillX().maxHeight(520f).row();
    }
}
