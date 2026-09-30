package lanlink.net;

import arc.func.Cons;
import arc.util.Log;

import java.util.Collections;

/**
 * 网络诊断工具：测试控制面连接、延迟、状态。
 */
public final class NetworkDiagnostics{
    private NetworkDiagnostics(){
    }

    /**
     * 诊断结果。
     */
    public static class DiagnosticResult{
        public final boolean ok;
        public final long latencyMs;
        public final String message;
        public final String suggestion;

        public DiagnosticResult(boolean ok, long latencyMs, String message, String suggestion){
            this.ok = ok;
            this.latencyMs = latencyMs;
            this.message = message == null ? "" : message;
            this.suggestion = suggestion == null ? "" : suggestion;
        }

        public static DiagnosticResult ok(long latencyMs, String message){
            return new DiagnosticResult(true, latencyMs, message, "");
        }

        public static DiagnosticResult warn(long latencyMs, String message, String suggestion){
            return new DiagnosticResult(false, latencyMs, message, suggestion);
        }

        public static DiagnosticResult error(String message, String suggestion){
            return new DiagnosticResult(false, -1, message, suggestion);
        }
    }

    /**
     * 异步测试控制面连接。
     *
     * @param controlUrl 控制面地址
     * @param done       完成回调（在主线程调用）
     */
    public static void testControlPlaneAsync(String controlUrl, Cons<DiagnosticResult> done){
        Thread t = new Thread(() -> {
            DiagnosticResult result = testControlPlane(controlUrl);
            arc.Core.app.post(() -> done.get(result));
        }, "lanlink-diagnose");
        t.setDaemon(true);
        t.start();
    }

    /**
     * 同步测试控制面连接（在后台线程调用）。
     *
     * @param controlUrl 控制面地址
     * @return 诊断结果
     */
    public static DiagnosticResult testControlPlane(String controlUrl){
        long start = System.currentTimeMillis();
        String healthUrl = ControlPlaneApi.normalizeHttpBase(controlUrl) + "/api/health";

        try{
            ControlPlaneApi.HttpResponse resp = ControlPlaneApi.httpGet(
                healthUrl,
                Collections.emptyMap()
            );
            long latency = System.currentTimeMillis() - start;

            if(resp.statusCode == 200){
                return DiagnosticResult.ok(latency, "控制面连接正常");
            }else if(resp.statusCode == 404){
                return DiagnosticResult.warn(latency,
                    "控制面不支持健康检查接口",
                    "连接正常，但该控制面版本较旧");
            }else{
                return DiagnosticResult.warn(latency,
                    "控制面响应异常（HTTP " + resp.statusCode + "）",
                    "请检查控制面状态或联系管理员");
            }
        }catch(Throwable t){
            Log.err("[LanLink] diagnostics failed", t);
            String errorMsg = t.getMessage();
            String suggestion = generateSuggestion(errorMsg);
            return DiagnosticResult.error(
                "无法连接控制面: " + lanlink.util.ErrorMessage.friendly(errorMsg),
                suggestion
            );
        }
    }

    /**
     * 根据错误信息生成建议。
     */
    private static String generateSuggestion(String errorMsg){
        if(errorMsg == null) return "请检查网络连接";

        if(errorMsg.contains("Connection refused")){
            return "服务器可能未启动，请检查控制面地址是否正确";
        }
        if(errorMsg.contains("timeout") || errorMsg.contains("timed out")){
            return "网络连接慢或服务器无响应，请稍后重试";
        }
        if(errorMsg.contains("Unknown host") || errorMsg.contains("Unable to resolve host")){
            return "控制面地址无法解析，请检查地址是否正确";
        }
        if(errorMsg.contains("SSL") || errorMsg.contains("certificate")){
            return "安全连接失败，请检查网络环境或尝试使用 http:// 前缀";
        }
        if(errorMsg.contains("Network is unreachable")){
            return "网络不可达，请检查网络连接";
        }

        return "请检查网络连接或控制面地址";
    }
}
