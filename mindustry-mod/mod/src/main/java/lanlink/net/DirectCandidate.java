package lanlink.net;

/** UPnP / STUN / 手动 直连候选地址。 */
public class DirectCandidate{
    public final boolean ok;
    public final String message;
    public final String mode;
    public final String addr;
    public final int port;

    public DirectCandidate(boolean ok, String message, String mode, String addr, int port){
        this.ok = ok;
        this.message = message;
        this.mode = mode;
        this.addr = addr;
        this.port = port;
    }

    public static DirectCandidate fail(String message){
        return new DirectCandidate(false, message, "", "", 0);
    }

    public static DirectCandidate upnp(String addr, int port){
        return new DirectCandidate(true, "UPnP 映射成功: " + addr + ":" + port, "upnp", addr, port);
    }

    public static DirectCandidate stun(String addr, int port){
        return new DirectCandidate(true, "STUN 发现: " + addr + ":" + port, "stun", addr, port);
    }

    public static DirectCandidate manual(String addr, int port){
        return new DirectCandidate(true, "手动直连: " + addr + ":" + port, "manual", addr, port);
    }

    public static DirectCandidate local(String addr, int port){
        return new DirectCandidate(true, "本地地址: " + addr + ":" + port, "local", addr, port);
    }
}
