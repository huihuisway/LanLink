package lanlink.net;

import arc.Core;
import arc.func.Cons;
import arc.util.Log;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.HttpURLConnection;
import java.net.InetAddress;
import java.net.MulticastSocket;
import java.net.NetworkInterface;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Enumeration;
import java.util.List;
import java.util.Locale;

/**
 * 最小 UPnP IGD 端口映射实现：发现网关 -> TCP/UDP AddPortMapping -> 删除映射。
 * 失败时只返回不可用，不影响原有中继开房流程。
 */
public class PortMapper{
    private static final String SSDP_ADDR = "239.255.255.250";
    private static final int SSDP_PORT = 1900;
    private static final int MAP_TTL_SECONDS = 3600;

    private Gateway gateway;
    private int mappedPort;
    private boolean mappedTcp, mappedUdp;

    public DirectCandidate map(int localPort){
        return map(localPort, null);
    }

    /**
     * @param localPort 要映射的本地端口
     * @param onProgress 可选的进度回调（如 "发现路由器..."），可 null
     */
    public DirectCandidate map(int localPort, Cons<String> onProgress){
        Object multicastLock = null;
        try{
            progress(onProgress, "发现路由器…");
            multicastLock = acquireAndroidMulticastLock();
            gateway = discoverGateway();
            releaseAndroidMulticastLock(multicastLock);
            multicastLock = null;
            if(gateway == null) return DirectCandidate.fail("未发现支持 UPnP 的路由器，使用中继");

            progress(onProgress, "确定本机内网地址…");
            String localAddr = localAddressFor(gateway.baseUrl.getHost());
            if(localAddr.isEmpty()) return DirectCandidate.fail("无法确定本机内网地址，使用中继");

            progress(onProgress, "读取公网地址…");
            String externalIp = getExternalIp(gateway);
            if(externalIp.isEmpty()) return DirectCandidate.fail("无法读取公网地址，使用中继");

            progress(onProgress, "映射 TCP 端口…");
            mappedTcp = addPortMapping(gateway, localPort, localPort, localAddr, "TCP");
            progress(onProgress, "映射 UDP 端口…");
            mappedUdp = addPortMapping(gateway, localPort, localPort, localAddr, "UDP");
            if(!mappedTcp || !mappedUdp){
                close();
                return DirectCandidate.fail("UPnP 映射 TCP/UDP 端口失败，使用中继");
            }
            mappedPort = localPort;
            progress(onProgress, "UPnP 映射成功");
            return DirectCandidate.upnp(externalIp, localPort);
        }catch(Throwable t){
            Log.err("[LanLink] UPnP map failed", t);
            releaseAndroidMulticastLock(multicastLock);
            close();
            return DirectCandidate.fail("UPnP 映射失败: " + t.getMessage());
        }
    }

    private void progress(Cons<String> cb, String step){
        if(cb != null){
            try{ cb.get(step); }catch(Throwable ignored){}
        }
    }

    public void close(){
        if(gateway == null || mappedPort <= 0) return;
        try{
            if(mappedTcp) deletePortMapping(gateway, mappedPort, "TCP");
        }catch(Throwable ignored){}
        try{
            if(mappedUdp) deletePortMapping(gateway, mappedPort, "UDP");
        }catch(Throwable ignored){}
        mappedTcp = false;
        mappedUdp = false;
        mappedPort = 0;
        gateway = null;
    }

    private Object acquireAndroidMulticastLock(){
        if(!Core.app.isAndroid()) return null;
        try{
            Object context = androidContext();
            if(context == null) return null;
            Object appContext = invokeIfExists(context, "getApplicationContext");
            if(appContext != null) context = appContext;
            Object wifi = context.getClass().getMethod("getSystemService", String.class).invoke(context, "wifi");
            if(wifi == null) return null;
            Object lock = wifi.getClass().getMethod("createMulticastLock", String.class).invoke(wifi, "LanLink-UPnP");
            try{
                lock.getClass().getMethod("setReferenceCounted", boolean.class).invoke(lock, false);
            }catch(Throwable ignored){}
            lock.getClass().getMethod("acquire").invoke(lock);
            return lock;
        }catch(Throwable t){
            Log.warn("[LanLink] Android multicast lock unavailable: @", t.getMessage());
            return null;
        }
    }

    private void releaseAndroidMulticastLock(Object lock){
        if(lock == null) return;
        try{
            lock.getClass().getMethod("release").invoke(lock);
        }catch(Throwable ignored){}
    }

    private Object androidContext(){
        Object app = Core.app;
        Object context = invokeIfExists(app, "getContext");
        if(context != null) return context;
        context = invokeIfExists(app, "getApplicationContext");
        if(context != null) return context;
        try{
            java.lang.reflect.Field field = app.getClass().getDeclaredField("context");
            field.setAccessible(true);
            return field.get(app);
        }catch(Throwable ignored){
            return null;
        }
    }

    private Object invokeIfExists(Object target, String name){
        try{
            return target.getClass().getMethod(name).invoke(target);
        }catch(Throwable ignored){
            return null;
        }
    }

    private Gateway discoverGateway() throws Exception{
        List<String> targets = new ArrayList<>();
        targets.add("urn:schemas-upnp-org:device:InternetGatewayDevice:1");
        targets.add("urn:schemas-upnp-org:service:WANIPConnection:1");
        targets.add("urn:schemas-upnp-org:service:WANPPPConnection:1");

        long deadline = System.currentTimeMillis() + 2500L;
        try(DatagramSocket socket = new DatagramSocket()){
            socket.setSoTimeout(700);
            InetAddress addr = InetAddress.getByName(SSDP_ADDR);
            for(String target : targets){
                String req = "M-SEARCH * HTTP/1.1\r\n"
                    + "HOST: " + SSDP_ADDR + ":" + SSDP_PORT + "\r\n"
                    + "MAN: \"ssdp:discover\"\r\n"
                    + "MX: 2\r\n"
                    + "ST: " + target + "\r\n\r\n";
                byte[] data = req.getBytes(StandardCharsets.UTF_8);
                socket.send(new DatagramPacket(data, data.length, addr, SSDP_PORT));
            }

            byte[] buf = new byte[8192];
            while(System.currentTimeMillis() < deadline){
                try{
                    DatagramPacket packet = new DatagramPacket(buf, buf.length);
                    socket.receive(packet);
                    String res = new String(packet.getData(), packet.getOffset(), packet.getLength(), StandardCharsets.UTF_8);
                    String location = header(res, "location");
                    if(!location.isEmpty()){
                        Gateway g = parseGateway(location);
                        if(g != null) return g;
                    }
                }catch(Throwable ignored){}
            }
        }
        return null;
    }

    private Gateway parseGateway(String location) throws Exception{
        URL descUrl = new URL(location);
        String xml = httpGet(descUrl);
        String serviceType = "urn:schemas-upnp-org:service:WANIPConnection:1";
        String controlUrl = controlUrlFor(xml, serviceType);
        if(controlUrl.isEmpty()){
            serviceType = "urn:schemas-upnp-org:service:WANPPPConnection:1";
            controlUrl = controlUrlFor(xml, serviceType);
        }
        if(controlUrl.isEmpty()) return null;
        return new Gateway(descUrl, new URL(descUrl, controlUrl), serviceType);
    }

    private String controlUrlFor(String xml, String serviceType){
        String marker = "<serviceType>" + serviceType + "</serviceType>";
        int typeAt = xml.indexOf(marker);
        if(typeAt < 0) return "";
        int serviceStart = xml.lastIndexOf("<service>", typeAt);
        int serviceEnd = xml.indexOf("</service>", typeAt);
        if(serviceStart < 0 || serviceEnd < 0) return "";
        String service = xml.substring(serviceStart, serviceEnd);
        return tag(service, "controlURL");
    }

    private String getExternalIp(Gateway gateway) throws Exception{
        String body = soap(gateway, "GetExternalIPAddress", "");
        return tag(body, "NewExternalIPAddress");
    }

    private boolean addPortMapping(Gateway gateway, int externalPort, int internalPort, String internalClient, String protocol) throws Exception{
        String args = "<NewRemoteHost></NewRemoteHost>"
            + "<NewExternalPort>" + externalPort + "</NewExternalPort>"
            + "<NewProtocol>" + protocol + "</NewProtocol>"
            + "<NewInternalPort>" + internalPort + "</NewInternalPort>"
            + "<NewInternalClient>" + internalClient + "</NewInternalClient>"
            + "<NewEnabled>1</NewEnabled>"
            + "<NewPortMappingDescription>LanLink Mindustry</NewPortMappingDescription>"
            + "<NewLeaseDuration>" + MAP_TTL_SECONDS + "</NewLeaseDuration>";
        soap(gateway, "AddPortMapping", args);
        return true;
    }

    private void deletePortMapping(Gateway gateway, int externalPort, String protocol) throws Exception{
        String args = "<NewRemoteHost></NewRemoteHost>"
            + "<NewExternalPort>" + externalPort + "</NewExternalPort>"
            + "<NewProtocol>" + protocol + "</NewProtocol>";
        soap(gateway, "DeletePortMapping", args);
    }

    private String soap(Gateway gateway, String action, String args) throws Exception{
        String envelope = "<?xml version=\"1.0\"?>"
            + "<s:Envelope xmlns:s=\"http://schemas.xmlsoap.org/soap/envelope/\" s:encodingStyle=\"http://schemas.xmlsoap.org/soap/encoding/\">"
            + "<s:Body><u:" + action + " xmlns:u=\"" + gateway.serviceType + "\">"
            + args
            + "</u:" + action + "></s:Body></s:Envelope>";
        HttpURLConnection conn = (HttpURLConnection)gateway.controlUrl.openConnection();
        try{
            conn.setConnectTimeout(4000);
            conn.setReadTimeout(5000);
            conn.setRequestMethod("POST");
            conn.setDoOutput(true);
            conn.setRequestProperty("Content-Type", "text/xml; charset=\"utf-8\"");
            conn.setRequestProperty("SOAPAction", "\"" + gateway.serviceType + "#" + action + "\"");
            byte[] bytes = envelope.getBytes(StandardCharsets.UTF_8);
            conn.setRequestProperty("Content-Length", String.valueOf(bytes.length));
            try(OutputStream out = conn.getOutputStream()){
                out.write(bytes);
            }
            int code = conn.getResponseCode();
            String body = readText(code >= 200 && code < 300 ? conn.getInputStream() : conn.getErrorStream());
            if(code < 200 || code >= 300) throw new RuntimeException("UPnP " + action + " HTTP " + code + " " + body);
            return body;
        }finally{
            conn.disconnect();
        }
    }

    private String httpGet(URL url) throws Exception{
        HttpURLConnection conn = (HttpURLConnection)url.openConnection();
        try{
            conn.setConnectTimeout(4000);
            conn.setReadTimeout(5000);
            return readText(conn.getInputStream());
        }finally{
            conn.disconnect();
        }
    }

    private String localAddressFor(String host) throws Exception{
        try(DatagramSocket socket = new DatagramSocket()){
            socket.connect(InetAddress.getByName(host), 9);
            return socket.getLocalAddress().getHostAddress();
        }
    }

    private String readText(InputStream stream) throws Exception{
        if(stream == null) return "";
        try(BufferedReader reader = new BufferedReader(new InputStreamReader(stream, StandardCharsets.UTF_8))){
            StringBuilder sb = new StringBuilder();
            String line;
            while((line = reader.readLine()) != null) sb.append(line).append('\n');
            return sb.toString();
        }
    }

    private String header(String response, String name){
        String prefix = name.toLowerCase(Locale.ROOT) + ":";
        String[] lines = response.split("\\r?\\n");
        for(String line : lines){
            String l = line.toLowerCase(Locale.ROOT);
            if(l.startsWith(prefix)) return line.substring(line.indexOf(':') + 1).trim();
        }
        return "";
    }

    private String tag(String xml, String name){
        int start = xml.indexOf("<" + name + ">");
        if(start < 0) return "";
        start += name.length() + 2;
        int end = xml.indexOf("</" + name + ">", start);
        if(end < 0) return "";
        return xml.substring(start, end).trim();
    }

    private static class Gateway{
        final URL baseUrl;
        final URL controlUrl;
        final String serviceType;

        Gateway(URL baseUrl, URL controlUrl, String serviceType){
            this.baseUrl = baseUrl;
            this.controlUrl = controlUrl;
            this.serviceType = serviceType;
        }
    }
}
