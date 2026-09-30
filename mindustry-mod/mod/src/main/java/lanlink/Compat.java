package lanlink;

import mindustry.core.Version;

/**
 * v7/v8 差异的唯一收敛点。
 * 规则：任何随游戏版本变化的 API 调用都必须经过这里，禁止在业务代码里散落版本判断。
 */
public final class Compat{

    private Compat(){
    }

    /** 当前游戏 build 号（v7 = 146/147，v8 = 149+）。 */
    public static int gameBuild(){
        return Version.build;
    }

    /** 是否运行在 v8+。 */
    public static boolean isV8(){
        return Version.build >= 149;
    }
}
