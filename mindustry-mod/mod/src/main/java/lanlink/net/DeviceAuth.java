package lanlink.net;

import arc.util.Log;
import arc.util.serialization.Jval;
import lanlink.auth.AuthSession;
import lanlink.util.JsonUtils;

import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Map;

/**
 * MindAuth 设备授权流（RFC 8628）封装。
 * Mod 调 /api/auth/device/start 拿 user_code，用户在浏览器确认，
 * Mod 轮询 /api/auth/device/poll 拿 token。
 */
public final class DeviceAuth{
    private DeviceAuth(){
    }

    public static class StartResult{
        public final boolean ok;
        public final String message;
        public final String sessionId;
        public final String userCode;
        public final String verificationUri;
        public final String verificationUriComplete;
        public final int expiresIn;
        public final int interval;

        public StartResult(boolean ok, String message, String sessionId, String userCode,
                           String verificationUri, String verificationUriComplete,
                           int expiresIn, int interval){
            this.ok = ok;
            this.message = message;
            this.sessionId = sessionId == null ? "" : sessionId;
            this.userCode = userCode == null ? "" : userCode;
            this.verificationUri = verificationUri == null ? "" : verificationUri;
            this.verificationUriComplete = verificationUriComplete == null ? "" : verificationUriComplete;
            this.expiresIn = expiresIn;
            this.interval = interval;
        }

        public static StartResult error(String message){
            return new StartResult(false, message, "", "", "", "", 0, 5);
        }
    }

    public static class PollResult{
        public final boolean ok;
        public final String status;
        public final String message;
        public final AuthSession session;

        public PollResult(boolean ok, String status, String message, AuthSession session){
            this.ok = ok;
            this.status = status == null ? "" : status;
            this.message = message;
            this.session = session;
        }

        public static PollResult pending(){
            return new PollResult(false, "pending", "等待浏览器确认…", null);
        }

        public static PollResult error(String status, String message){
            return new PollResult(false, status, message, null);
        }
    }

    /** 调控制面 /api/auth/device/start */
    public static StartResult start(String controlUrl){
        String apiUrl = ControlPlaneApi.normalizeHttpBase(controlUrl) + "/api/auth/device/start";
        try{
            Map<String, String> headers = new HashMap<>();
            headers.put("Accept", "application/json");
            headers.put("Content-Type", "application/json; charset=utf-8");
            byte[] body = "{}".getBytes(StandardCharsets.UTF_8);
            ControlPlaneApi.HttpResponse resp = ControlPlaneApi.httpPost(apiUrl, headers, body);

            // 调试日志：记录完整的请求和响应信息
            Log.info("[LanLink] Device auth start request: " + apiUrl);
            Log.info("[LanLink] Device auth response status: " + resp.statusCode);
            Log.info("[LanLink] Device auth response body: " + resp.body);

            if(resp.statusCode == 404){
                String errorMsg = "该控制面不支持设备授权（HTTP 404）";
                if(resp.body != null && !resp.body.isEmpty()){
                    errorMsg += "\n响应: " + resp.body;
                }
                errorMsg += "\n请升级服务端或使用识别码登录";
                return StartResult.error(errorMsg);
            }
            if(resp.statusCode == 503){
                String errorMsg = "设备授权服务不可用（HTTP 503）";
                if(resp.body != null && !resp.body.isEmpty()){
                    errorMsg += "\n响应: " + resp.body;
                }
                return StartResult.error(errorMsg);
            }
            if(resp.statusCode < 200 || resp.statusCode >= 300){
                String errorMsg = "设备授权启动失败（HTTP " + resp.statusCode + "）";
                if(resp.body != null && !resp.body.isEmpty()){
                    errorMsg += "\n响应: " + resp.body;
                }
                return StartResult.error(errorMsg);
            }
            return parseStartJson(resp.body);
        }catch(Throwable t){
            Log.err("[LanLink] device auth start failed", t);
            return StartResult.error("设备授权启动失败: " + t.getMessage());
        }
    }

    /** 调控制面 /api/auth/device/poll */
    public static PollResult poll(String controlUrl, String sessionId){
        String apiUrl = ControlPlaneApi.normalizeHttpBase(controlUrl) + "/api/auth/device/poll";
        try{
            Map<String, String> headers = new HashMap<>();
            headers.put("Accept", "application/json");
            headers.put("Content-Type", "application/json; charset=utf-8");
            String payload = "{\"session_id\":\"" + JsonUtils.escapeJson(sessionId) + "\"}";
            byte[] body = payload.getBytes(StandardCharsets.UTF_8);
            ControlPlaneApi.HttpResponse resp = ControlPlaneApi.httpPost(apiUrl, headers, body);

            // 调试日志：记录完整的请求和响应信息
            Log.info("[LanLink] Device auth poll request: " + apiUrl);
            Log.info("[LanLink] Device auth poll response status: " + resp.statusCode);
            Log.info("[LanLink] Device auth poll response body: " + resp.body);

            if(resp.statusCode < 200 || resp.statusCode >= 300){
                String errorMsg = "轮询失败（HTTP " + resp.statusCode + "）";
                if(resp.body != null && !resp.body.isEmpty()){
                    errorMsg += "\n响应: " + resp.body;
                }
                return PollResult.error("error", errorMsg);
            }
            return parsePollJson(resp.body);
        }catch(Throwable t){
            Log.err("[LanLink] device auth poll failed", t);
            return PollResult.error("error", "轮询失败: " + t.getMessage());
        }
    }

    private static StartResult parseStartJson(String body){
        try{
            Jval root = Jval.read(body);
            if(!root.getBool("ok", false)){
                return StartResult.error(root.getString("message", "设备授权启动失败"));
            }
            return new StartResult(
                true,
                "设备授权已启动",
                root.getString("session_id", ""),
                root.getString("user_code", ""),
                root.getString("verification_uri", ""),
                root.getString("verification_uri_complete", ""),
                root.getInt("expires_in", 600),
                root.getInt("interval", 5)
            );
        }catch(Throwable t){
            Log.err("[LanLink] parse device auth start failed", t);
            return StartResult.error("控制面返回解析失败: " + t.getMessage());
        }
    }

    private static PollResult parsePollJson(String body){
        try{
            Jval root = Jval.read(body);
            boolean ok = root.getBool("ok", false);
            if(ok){
                Jval user = root.get("user");
                if(user == null){
                    return PollResult.error("error", "控制面返回格式不正确");
                }
                AuthSession session = new AuthSession(
                    root.getString("token", ""),
                    user.getString("username", ""),
                    user.getString("display_name", user.getString("username", "")),
                    user.getString("role", "")
                );
                if(!session.loggedIn){
                    return PollResult.error("error", "控制面返回登录态不完整");
                }
                return new PollResult(true, "success", "已登录为 " + session.displayName, session);
            }
            String status = root.getString("status", "pending");
            String message;
            switch(status){
                case "pending":
                    return PollResult.pending();
                case "expired":
                    message = "授权码已过期，请重试";
                    break;
                case "denied":
                    message = "授权已被拒绝";
                    break;
                default:
                    message = root.getString("message", "等待确认中…");
                    break;
            }
            return PollResult.error(status, message);
        }catch(Throwable t){
            Log.err("[LanLink] parse device auth poll failed", t);
            return PollResult.error("error", "控制面返回解析失败: " + t.getMessage());
        }
    }

}
