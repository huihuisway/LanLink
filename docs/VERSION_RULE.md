# 版本规则

## 自动递增规则

本项目使用 git pre-commit hook 自动递增小版本号（MINOR version）。

每次 `git commit` 时，hook 会自动执行 `scripts/bump-minor-version.sh`，将版本号递增：

```
0.1.0 → 0.2.0 → 0.3.0 → 0.4.0 → ...
```

## 手动递增

如需手动递增：

```bash
./scripts/bump-minor-version.sh
```

## 版本格式

遵循 [Semantic Versioning](https://semver.org/) 格式：`MAJOR.MINOR.PATCH`

- **MAJOR**：不兼容的 API 变更
- **MINOR**：向后兼容的功能新增（每次 commit 自动递增）
- **PATCH**：保留为 0，不单独递增
