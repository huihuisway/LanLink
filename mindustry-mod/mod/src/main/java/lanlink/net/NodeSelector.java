package lanlink.net;

import java.net.InetSocketAddress;
import java.net.Socket;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.Callable;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;

/** Client-side node probing and balanced selection for quick hosting. */
public final class NodeSelector{
    private NodeSelector(){
    }

    public static ControlPlaneApi.NodeInfo selectBest(List<ControlPlaneApi.NodeInfo> source){
        List<ControlPlaneApi.NodeInfo> nodes = new ArrayList<>();
        for(ControlPlaneApi.NodeInfo node : source){
            if(node.usable && !node.addr.isEmpty() && node.tunnelPort > 0) nodes.add(node);
        }
        if(nodes.isEmpty()) return null;

        ExecutorService pool = Executors.newFixedThreadPool(Math.min(4, nodes.size()));
        try{
            List<Future<Long>> futures = new ArrayList<>();
            for(ControlPlaneApi.NodeInfo node : nodes){
                futures.add(pool.submit((Callable<Long>)() -> probe(node.addr, node.tunnelPort)));
            }
            for(int i = 0; i < nodes.size(); i++){
                try{
                    nodes.get(i).latencyMs = futures.get(i).get();
                }catch(Throwable ignored){
                    nodes.get(i).latencyMs = -1L;
                }
            }
        }finally{
            pool.shutdownNow();
        }

        int roomsMaximum = 1;
        int sessionsMaximum = 1;
        double mbpsMaximum = 1d;
        for(ControlPlaneApi.NodeInfo node : nodes){
            roomsMaximum = Math.max(roomsMaximum, node.rooms);
            sessionsMaximum = Math.max(sessionsMaximum, node.sessions);
            mbpsMaximum = Math.max(mbpsMaximum, node.mbpsUsed);
        }
        final int maxRooms = roomsMaximum;
        final int maxSessions = sessionsMaximum;
        final double maxMbps = mbpsMaximum;

        // Avoid Comparator entirely. D8 generates Comparator$-CC bridge calls
        // even for an anonymous Comparator, and Mindustry's isolated Android
        // ModClassLoader cannot resolve that desugaring companion class.
        ControlPlaneApi.NodeInfo best = nodes.get(0);
        for(int i = 1; i < nodes.size(); i++){
            ControlPlaneApi.NodeInfo candidate = nodes.get(i);
            if(isBetter(candidate, best, maxRooms, maxSessions, maxMbps)) best = candidate;
        }
        return best;
    }

    private static boolean isBetter(ControlPlaneApi.NodeInfo candidate, ControlPlaneApi.NodeInfo current,
                                    int maxRooms, int maxSessions, double maxMbps){
        int byScore = Double.compare(
            score(candidate, maxRooms, maxSessions, maxMbps),
            score(current, maxRooms, maxSessions, maxMbps)
        );
        if(byScore != 0) return byScore < 0;
        if(candidate.official != current.official) return candidate.official;
        return candidate.rooms < current.rooms;
    }

    static double score(ControlPlaneApi.NodeInfo node, int maxRooms, int maxSessions, double maxMbps){
        double latency = node.latencyMs < 0 ? 1d : Math.min(node.latencyMs, 300d) / 300d;
        double sessions = (double)node.sessions / maxSessions;
        double rooms = (double)node.rooms / maxRooms;
        double bandwidth = node.mbpsUsed / maxMbps;
        return latency * 0.50d + sessions * 0.25d + rooms * 0.15d + bandwidth * 0.10d;
    }

    private static long probe(String addr, int port){
        long best = Long.MAX_VALUE;
        for(int attempt = 0; attempt < 2; attempt++){
            long started = System.nanoTime();
            try(Socket socket = new Socket()){
                socket.connect(new InetSocketAddress(addr, port), 1500);
                best = Math.min(best, (System.nanoTime() - started) / 1_000_000L);
            }catch(Throwable ignored){
                // A failed probe is ranked behind measurable nodes but remains usable.
            }
        }
        return best == Long.MAX_VALUE ? -1L : best;
    }
}
