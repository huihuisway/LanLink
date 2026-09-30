package lanlink.util;

/**
 * Lightweight JSON string helpers.
 * <p>
 * This class intentionally avoids pulling in a full JSON library; the Mod only
 * needs to escape a handful of user-supplied values that are interpolated into
 * hand-built JSON payloads.
 */
public final class JsonUtils{

    private JsonUtils(){
    }

    /**
     * Escape a string value for safe inclusion inside a JSON double-quoted
     * literal. Handles the characters that must be escaped per RFC 8259
     * ({@code "}, {@code \}, control characters) and passes everything else
     * through unchanged.
     *
     * @param value the raw string; must not be {@code null}
     * @return the escaped string, never {@code null}
     */
    public static String escapeJson(String value){
        StringBuilder out = new StringBuilder();
        for(int i = 0; i < value.length(); i++){
            char c = value.charAt(i);
            if(c == '"' || c == '\\') out.append('\\').append(c);
            else if(c == '\n') out.append("\\n");
            else if(c == '\r') out.append("\\r");
            else if(c == '\t') out.append("\\t");
            else out.append(c);
        }
        return out.toString();
    }
}
