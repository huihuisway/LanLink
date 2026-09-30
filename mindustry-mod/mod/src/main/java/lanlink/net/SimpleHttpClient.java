package lanlink.net;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Map;
import javax.net.ssl.SSLSocket;
import javax.net.ssl.SSLSocketFactory;

/**
 * 最小 HTTP 客户端，仅用 raw socket，完全绕开 Android 的 HttpURLConnection 网络策略
 * （包括 Android 9+ 的 "cleartext HTTP traffic not permitted" 限制）。
 *
 * 仅用于 Android 平台；桌面仍用 HttpURLConnection。
 * 支持：HTTP/1.1 GET / POST；请求/响应都是 UTF-8 文本；不处理 gzip、chunked、redirect。
 * 支持 HTTP 和 HTTPS（通过 SSLSocket）。
 */
public final class SimpleHttpClient{

    private static final int CONNECT_TIMEOUT_MS = 8000;
    private static final int READ_TIMEOUT_MS = 8000;
    private static final int MAX_RESPONSE_BYTES = 2 * 1024 * 1024; // 2MB 上限

    public static final class Response{
        public final int statusCode;
        public final String body;

        public Response(int statusCode, String body){
            this.statusCode = statusCode;
            this.body = body;
        }
    }

    private SimpleHttpClient(){
    }

    /**
     * 发 HTTP 请求。
     *
     * @param method  "GET" 或 "POST"
     * @param url     完整 URL，支持 http:// 和 https://
     * @param headers 额外请求头（如 Authorization），可 null
     * @param body    POST 请求体，GET 传 null
     */
    public static Response request(String method, String url, Map<String, String> headers, byte[] body) throws Exception{
        // 1. 解析 URL
        URL u = new URL(url);
        boolean https = "https".equalsIgnoreCase(u.getProtocol());
        String host = u.getHost();
        int port = u.getPort();
        int defaultPort = https ? 443 : 80;
        if(port <= 0) port = defaultPort;
        String path = u.getPath();
        if(path.isEmpty()) path = "/";
        String query = u.getQuery();
        if(query != null && !query.isEmpty()) path = path + "?" + query;

        // 2. 连接（HTTPS 用 SSLSocket，HTTP 用普通 Socket）
        Socket socket;
        if(https){
            socket = SSLSocketFactory.getDefault().createSocket();
        }else{
            socket = new Socket();
        }
        try{
            socket.connect(new InetSocketAddress(host, port), CONNECT_TIMEOUT_MS);
            socket.setSoTimeout(READ_TIMEOUT_MS);

            OutputStream out = socket.getOutputStream();
            InputStream in = socket.getInputStream();

            // 3. 写请求行 + 请求头
            StringBuilder reqHead = new StringBuilder();
            reqHead.append(method).append(' ').append(path).append(" HTTP/1.1\r\n");
            reqHead.append("Host: ").append(host);
            if(port != defaultPort) reqHead.append(':').append(port);
            reqHead.append("\r\n");
            reqHead.append("Connection: close\r\n");
            if(headers != null){
                for(Map.Entry<String, String> e : headers.entrySet()){
                    reqHead.append(e.getKey()).append(": ").append(e.getValue()).append("\r\n");
                }
            }
            if(body != null && body.length > 0){
                if(headers == null || !containsKey(headers, "Content-Length")){
                    reqHead.append("Content-Length: ").append(body.length).append("\r\n");
                }
            }else{
                reqHead.append("Content-Length: 0\r\n");
            }
            reqHead.append("\r\n");

            out.write(reqHead.toString().getBytes(StandardCharsets.UTF_8));
            if(body != null && body.length > 0){
                out.write(body);
            }
            out.flush();

            // 4. 读响应
            return readResponse(in);
        }finally{
            try{ socket.close(); }catch(Throwable ignored){}
        }
    }

    private static boolean containsKey(Map<String, String> map, String key){
        for(String k : map.keySet()){
            if(k.equalsIgnoreCase(key)) return true;
        }
        return false;
    }

    private static Response readResponse(InputStream in) throws Exception{
        // 4a. 读状态行：HTTP/1.1 200 OK\r\n
        String statusLine = readLine(in);
        if(statusLine == null || statusLine.isEmpty()){
            throw new RuntimeException("Empty HTTP response");
        }
        int statusCode = parseStatusCode(statusLine);

        // 4b. 读响应头，找 Content-Length（无则读到连接关闭）
        int contentLength = -1;
        String line;
        while((line = readLine(in)) != null){
            if(line.isEmpty()) break; // 空行 = 头结束
            int colon = line.indexOf(':');
            if(colon > 0){
                String name = line.substring(0, colon).trim();
                String value = line.substring(colon + 1).trim();
                if(name.equalsIgnoreCase("Content-Length")){
                    try{ contentLength = Integer.parseInt(value); }catch(Throwable ignored){}
                }
            }
        }

        // 4c. 读响应体
        byte[] bodyBytes;
        if(contentLength >= 0){
            bodyBytes = readExactly(in, contentLength);
        }else{
            bodyBytes = readAll(in);
        }
        return new Response(statusCode, new String(bodyBytes, StandardCharsets.UTF_8));
    }

    private static int parseStatusCode(String statusLine){
        // "HTTP/1.1 200 OK" → 200
        int firstSpace = statusLine.indexOf(' ');
        if(firstSpace < 0) throw new RuntimeException("Malformed status line: " + statusLine);
        int secondSpace = statusLine.indexOf(' ', firstSpace + 1);
        String code = secondSpace > 0 ? statusLine.substring(firstSpace + 1, secondSpace) : statusLine.substring(firstSpace + 1);
        try{
            return Integer.parseInt(code.trim());
        }catch(Throwable t){
            throw new RuntimeException("Malformed status code: " + statusLine);
        }
    }

    private static String readLine(InputStream in) throws Exception{
        ByteArrayOutputStream buf = new ByteArrayOutputStream();
        int b;
        while((b = in.read()) != -1){
            if(b == '\r'){
                int next = in.read();
                if(next == '\n') break;
                if(next != -1) buf.write(next);
                break;
            }
            if(b == '\n') break;
            buf.write(b);
            if(buf.size() > 8192) break; // 安全上限
        }
        if(b == -1 && buf.size() == 0) return null;
        return buf.toString("UTF-8");
    }

    private static byte[] readExactly(InputStream in, int length) throws Exception{
        if(length > MAX_RESPONSE_BYTES) throw new RuntimeException("Response too large: " + length);
        byte[] buf = new byte[length];
        int offset = 0;
        while(offset < length){
            int n = in.read(buf, offset, length - offset);
            if(n < 0) break;
            offset += n;
        }
        if(offset < length){
            byte[] truncated = new byte[offset];
            System.arraycopy(buf, 0, truncated, 0, offset);
            return truncated;
        }
        return buf;
    }

    private static byte[] readAll(InputStream in) throws Exception{
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buf = new byte[4096];
        int total = 0;
        int n;
        while((n = in.read(buf)) != -1){
            out.write(buf, 0, n);
            total += n;
            if(total > MAX_RESPONSE_BYTES) throw new RuntimeException("Response too large");
        }
        return out.toByteArray();
    }
}
