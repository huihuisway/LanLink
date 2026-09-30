#!/bin/bash
# 自动递增小版本号 (MINOR version)
# 作为 git pre-commit hook 运行，自动 stage 版本改动

# 读取当前版本
VERSION=$(grep '"version"' package.json | sed 's/.*"version": *"\([^"]*\)".*/\1/')

# 分割版本号
IFS='.' read -r MAJOR MINOR PATCH <<< "$VERSION"

# 递增 MINOR
MINOR=$((MINOR + 1))

# 写回新版本
NEW_VERSION="$MAJOR.$MINOR.$PATCH"
sed -i "s/\"version\": \"$VERSION\"/\"version\": \"$NEW_VERSION\"/" package.json

# 自动 stage 版本改动，使其包含在当前 commit 中
git add package.json

echo "版本更新: $VERSION → $NEW_VERSION"
