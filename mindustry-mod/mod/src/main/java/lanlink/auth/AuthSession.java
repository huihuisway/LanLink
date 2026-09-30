package lanlink.auth;

public class AuthSession{
    public final String token, userId, username, displayName, role;
    public final boolean loggedIn, phoneVerified;

    public AuthSession(String token, String username, String displayName, String role){
        this(token, "", username, displayName, role, false);
    }

    public AuthSession(String token, String userId, String username, String displayName, String role, boolean phoneVerified){
        this.token = token == null ? "" : token;
        this.userId = userId == null ? "" : userId;
        this.username = username == null ? "" : username;
        this.displayName = displayName == null ? "" : displayName;
        this.role = role == null ? "" : role;
        this.phoneVerified = phoneVerified;
        this.loggedIn = !this.token.isEmpty() && !this.username.isEmpty();
    }

    public static AuthSession anonymous(){
        return new AuthSession("", "", "", "", "", false);
    }
}
