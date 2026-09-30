package lanlink.net;

import arc.util.Log;
import arc.util.serialization.Jval;
import lanlink.auth.AuthSession;
import lanlink.util.JsonUtils;

import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Map;

/**
 * 用户名密码直接登录（替代设备授权流程）
 * Mod 调 /api/auth/login 提交凭证，直接获取 token
 */
public final class UsernamePasswordAuth {
    private UsernamePasswordAuth() {
    }

    public static class LoginResult {
        public final boolean ok;
        public final String message;
        public final AuthSession session;

        public LoginResult(boolean ok, String message, AuthSession session) {
            this.ok = ok;
            this.message = message;
            this.session = session;
        }

        public static LoginResult error(String message) {
            return new LoginResult(false, message, AuthSession.anonymous());
        }
    }

    /** 调控制面 /api/auth/login */
    public static LoginResult login(String controlUrl, String username, String password) {
        String apiUrl = ControlPlaneApi.normalizeHttpBase(controlUrl) + "/api/auth/login";
        try {
            Map<String, String> headers = new HashMap<>();
            headers.put("Accept", "application/json");
            headers.put("Content-Type", "application/json; charset=utf-8");

            String payload = "{\"username\":\"" + JsonUtils.escapeJson(username) +
                           "\",\"password\":\"" + JsonUtils.escapeJson(password) + "\"}";
            byte[] body = payload.getBytes(StandardCharsets.UTF_8);
            ControlPlaneApi.HttpResponse resp = ControlPlaneApi.httpPost(apiUrl, headers, body);

            if (resp.statusCode == 401) {
                return LoginResult.error("用户名或密码错误");
            }
            if (resp.statusCode == 429) {
                return LoginResult.error("登录尝试过于频繁，请稍后再试");
            }
            if (resp.statusCode < 200 || resp.statusCode >= 300) {
                String errorMsg = "登录失败（HTTP " + resp.statusCode + "）";
                if (resp.body != null && !resp.body.isEmpty()) {
                    errorMsg += "\n响应: " + resp.body;
                }
                return LoginResult.error(errorMsg);
            }

            return parseLoginJson(resp.body);
        } catch (Throwable t) {
            Log.err("[LanLink] login failed", t);
            return LoginResult.error("登录失败: " + t.getMessage());
        }
    }

    public static LoginResult refresh(String controlUrl, String token) {
        String apiUrl = ControlPlaneApi.normalizeHttpBase(controlUrl) + "/api/auth/refresh";
        try {
            Map<String, String> headers = new HashMap<>();
            headers.put("Accept", "application/json");
            headers.put("Authorization", "Bearer " + token);
            ControlPlaneApi.HttpResponse resp = ControlPlaneApi.httpPost(apiUrl, headers, new byte[0]);
            if (resp.statusCode == 401) return LoginResult.error("登录已失效，请重新登录");
            if (resp.statusCode == 429) return LoginResult.error("刷新过于频繁，请稍后重试");
            if (resp.statusCode < 200 || resp.statusCode >= 300) {
                return LoginResult.error("刷新验证状态失败（HTTP " + resp.statusCode + "）");
            }
            return parseLoginJson(resp.body);
        } catch (Throwable t) {
            Log.err("[LanLink] refresh auth failed", t);
            return LoginResult.error("刷新验证状态失败: " + t.getMessage());
        }
    }

    private static LoginResult parseLoginJson(String body) {
        try {
            Jval root = Jval.read(body);
            if (!root.getBool("ok", false)) {
                return LoginResult.error(root.getString("message", "登录失败"));
            }

            Jval user = root.get("user");
            if (user == null) {
                return LoginResult.error("控制面返回格式不正确");
            }

            AuthSession session = new AuthSession(
                root.getString("token", ""),
                String.valueOf(user.get("id") == null ? "" : user.get("id").toString().replace("\"", "")),
                user.getString("username", ""),
                user.getString("display_name", user.getString("username", "")),
                user.getString("role", ""),
                user.getBool("phone_verified", false)
            );

            if (!session.loggedIn) {
                return LoginResult.error("控制面返回登录态不完整");
            }

            return new LoginResult(true, "已登录为 " + session.displayName, session);
        } catch (Throwable t) {
            Log.err("[LanLink] parse login response failed", t);
            return LoginResult.error("控制面返回解析失败: " + t.getMessage());
        }
    }

}
