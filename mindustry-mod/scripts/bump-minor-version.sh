#!/bin/bash
# 自动递增小版本号 (MINOR version) - Gradle 项目
# 作为 git pre-commit hook 运行，自动 stage 版本改动

BUILD_GRADLE="mod/build.gradle"
MOD_HJSON="mod/mod.hjson"

# 读取当前版本
VERSION=$(grep "version = '" "$BUILD_GRADLE" | head -1 | sed "s/.*version = '\([^']*\)'.*/\1/")

if [ -z "$VERSION" ]; then
    echo "错误: 无法在 $BUILD_GRADLE 中找到 version"
    exit 1
fi

# 分割版本号
IFS='.' read -r MAJOR MINOR PATCH <<< "$VERSION"

# 递增 MINOR
MINOR=$((MINOR + 1))

# 写回新版本
NEW_VERSION="$MAJOR.$MINOR.$PATCH"
sed -i "s/version = '$VERSION'/version = '$NEW_VERSION'/" "$BUILD_GRADLE"
sed -i "s/^version: .*/version: $NEW_VERSION/" "$MOD_HJSON"

# 自动 stage 版本改动
git add "$BUILD_GRADLE" "$MOD_HJSON"

echo "版本更新: $VERSION → $NEW_VERSION"
