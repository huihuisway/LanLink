package lanlink.auth;

import arc.Core;

public final class AuthStore{
    private static final String TOKEN = "lanlink-auth-token";
    private static final String USER_ID = "lanlink-auth-user-id";
    private static final String USERNAME = "lanlink-auth-username";
    private static final String DISPLAY_NAME = "lanlink-auth-display-name";
    private static final String ROLE = "lanlink-auth-role";
    private static final String PHONE_VERIFIED = "lanlink-auth-phone-verified";

    private AuthStore(){
    }

    public static AuthSession load(){
        return new AuthSession(
            Core.settings.getString(TOKEN, ""),
            Core.settings.getString(USER_ID, ""),
            Core.settings.getString(USERNAME, ""),
            Core.settings.getString(DISPLAY_NAME, ""),
            Core.settings.getString(ROLE, ""),
            Core.settings.getBool(PHONE_VERIFIED, false)
        );
    }

    public static void save(AuthSession session){
        Core.settings.put(TOKEN, session.token);
        Core.settings.put(USER_ID, session.userId);
        Core.settings.put(USERNAME, session.username);
        Core.settings.put(DISPLAY_NAME, session.displayName);
        Core.settings.put(ROLE, session.role);
        Core.settings.put(PHONE_VERIFIED, session.phoneVerified);
    }

    public static void clear(){
        save(AuthSession.anonymous());
    }
}
