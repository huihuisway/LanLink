package lanlink.net;

import arc.func.Cons;

import java.util.ArrayList;
import java.util.List;

/**
 * 直连候选发现编排器：按 UPnP → STUN → 手动 顺序尝试，汇总所有可用候选。
 * 调用方（TunnelManager）拿到候选列表后一并发给控制面。
 */
public final class DirectDiscovery{

    private DirectDiscovery(){
    }

    public static class DiscoveryResult{
        public final List<DirectCandidate> candidates;
        public final String statusText;
        /** 如果 UPnP 成功，调用方必须在 cleanup 时 close() 此 mapper；否则为 null */
        public final PortMapper portMapper;

        public DiscoveryResult(List<DirectCandidate> candidates, String statusText, PortMapper portMapper){
            this.candidates = candidates;
            this.statusText = statusText;
            this.portMapper = portMapper;
        }
    }

    /**
     * 收集直连候选。
     *
     * @param localPort        本地游戏端口
     * @param manualAddr       用户手动输入的公网地址（可空）
     * @param manualPort       用户手动输入的公网端口
     * @param stunOverride     自定义 STUN 服务器地址（可空）
     * @param onProgress       进度回调（可 null）
     */
    public static DiscoveryResult discover(int localPort, String manualAddr, int manualPort,
                                           String stunOverride, Cons<String> onProgress){
        List<DirectCandidate> candidates = new ArrayList<>();
        StringBuilder status = new StringBuilder();
        PortMapper mapper = null;

        // 1. UPnP（家庭路由最可靠）
        try{
            progress(onProgress, "尝试 UPnP…");
            mapper = new PortMapper();
            DirectCandidate upnp = mapper.map(localPort, step -> progress(onProgress, "UPnP: " + step));
            if(upnp.ok){
                candidates.add(upnp);
                status.append("UPnP ✓ ");
            }else{
                mapper.close();
                mapper = null;
                status.append("UPnP ✗ ");
            }
        }catch(Throwable t){
            if(mapper != null){ mapper.close(); mapper = null; }
            status.append("UPnP ✗ ");
        }

        // 2. STUN（UPnP 失败时尤其重要）
        try{
            progress(onProgress, "STUN 发现公网地址…");
            DirectCandidate stun = (stunOverride != null && !stunOverride.isEmpty())
                ? StunClient.discover(stunOverride, 0)
                : StunClient.discover();
            if(stun.ok){
                // 如果 STUN 拿到的地址与 UPnP 完全相同（addr+port 一致），去重
                boolean dup = false;
                for(DirectCandidate c : candidates){
                    if(c.addr.equals(stun.addr) && c.port == stun.port){ dup = true; break; }
                }
                if(!dup){
                    candidates.add(stun);
                    status.append("STUN ✓ ");
                }else{
                    status.append("STUN (重复) ");
                }
            }else{
                status.append("STUN ✗ ");
            }
        }catch(Throwable t){
            status.append("STUN ✗ ");
        }

        // 3. 手动（用户知道端口转发已配置）
        if(manualAddr != null && !manualAddr.isEmpty() && manualPort > 0 && manualPort <= 65535){
            boolean dup = false;
            for(DirectCandidate c : candidates){
                if(c.addr.equals(manualAddr) && c.port == manualPort){ dup = true; break; }
            }
            if(!dup){
                candidates.add(DirectCandidate.manual(manualAddr, manualPort));
                status.append("手动 ✓");
            }else{
                status.append("手动 (重复)");
            }
        }

        String text;
        if(candidates.isEmpty()){
            text = "无可用直连方式，将使用中继";
        }else{
            text = status.toString().trim();
        }
        return new DiscoveryResult(candidates, text, mapper);
    }

    private static void progress(Cons<String> cb, String step){
        if(cb != null){
            try{ cb.get(step); }catch(Throwable ignored){}
        }
    }
}
