package lanlink.util;

/**
 * 错误消息工具类：将技术错误转换为用户友好的消息。
 */
public final class ErrorMessage{
    private ErrorMessage(){
    }

    /**
     * 将技术错误转换为用户友好的消息。
     *
     * @param technicalError 技术错误信息（如异常消息、HTTP 错误等）
     * @return 用户友好的中文消息
     */
    public static String friendly(String technicalError){
        if(technicalError == null || technicalError.isEmpty()){
            return "未知错误";
        }

        // 网络连接错误
        if(technicalError.contains("Connection refused")){
            return "无法连接到服务器，请检查网络连接";
        }
        if(technicalError.contains("Connection reset")){
            return "连接被重置，请重试";
        }
        if(technicalError.contains("Unknown host") || technicalError.contains("Unable to resolve host")){
            return "无法解析服务器地址，请检查网络";
        }
        if(technicalError.contains("timeout") || technicalError.contains("timed out")){
            return "连接超时，请检查网络或稍后重试";
        }
        if(technicalError.contains("Network is unreachable")){
            return "网络不可达，请检查网络连接";
        }

        // HTTP 状态码错误
        if(technicalError.contains("401")){
            return "登录已过期，请重新登录";
        }
        if(technicalError.contains("403")){
            return "无权执行此操作";
        }
        if(technicalError.contains("404")){
            return "请求的资源不存在";
        }
        if(technicalError.contains("429")){
            return "操作过于频繁，请稍后重试";
        }
        if(technicalError.contains("500")){
            return "服务器内部错误，请稍后重试";
        }
        if(technicalError.contains("502") || technicalError.contains("503")){
            return "服务器暂时不可用，请稍后重试";
        }
        if(technicalError.contains("504")){
            return "服务器响应超时，请稍后重试";
        }

        // SSL/TLS 错误
        if(technicalError.contains("SSL") || technicalError.contains("certificate")){
            return "安全连接失败，请检查网络环境";
        }

        // 默认返回原始错误（如果不够友好）
        return technicalError;
    }

    /**
     * 组合错误消息：主要消息 + 技术详情。
     *
     * @param message 主要错误消息
     * @param technicalDetail 技术详情（可选）
     * @return 组合后的消息
     */
    public static String withDetail(String message, String technicalDetail){
        if(technicalDetail == null || technicalDetail.isEmpty()){
            return message;
        }
        return message + "\n\n详情: " + technicalDetail;
    }
}
