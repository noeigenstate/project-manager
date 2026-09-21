# 自然风景背景

三个主题采用 macOS 自然风景壁纸，由 [512 Pixels 壁纸档案](https://512pixels.net/projects/default-mac-wallpapers-in-5k/)整理提供。选择依据是用户明确要求的“macOS 山川、海岸风景”，沿用现有三主题名称、配色和保存状态。

| 主题 | 壁纸/应用资源 | 尺寸 | 字节数 | 来源 |
| --- | --- | --- | --- | --- |
| 林间光影 | High Sierra / `src/assets/macos-high-sierra.webp` | 3840×2160 | 2,278,518 | [High Sierra](https://media.512pixels.net/downloads/macos-wallpapers-6k/10-13-6k.jpg) |
| 山青蓝 | Big Sur Day / `src/assets/macos-big-sur.webp` | 3840×3840 | 2,933,980 | [Big Sur Day](https://media.512pixels.net/downloads/macos-wallpapers-6k/11-Big-Sur-Day-6k.jpg) |
| 西野红 | Sierra / `src/assets/macos-sierra.webp` | 3840×2160 | 1,962,848 | [Sierra](https://media.512pixels.net/downloads/macos-wallpapers-6k/10-12-6k.jpg) |

- 三张源图分别为 6016×3384、6016×6016、6016×3384；约 66.05 MB 的 JPEG 编为总计 7,175,346 bytes 的 WebP。使用 ImageMagick 等比缩放至最大 3840×3840、WebP quality 88/method 6，没有重新绘制、增加文字或更换画面内容。
- 背景只绘制在 `.app-shell`，保持原有染色及液态玻璃透明度。`cover` 保持比例；Big Sur 使用 `center 35%` 保留天空和海岸，其他两张居中。
- 设置缩略图复用同一图片及裁切位置，不另外打包大图/缩略图副本。Vite 将文件打包为本地资源，运行时不下载图片，断网可用。
- 壁纸权利归 Apple 及相应权利人，来源档案由 Stephen Hackett 整理；不将第三方图片声明为项目原创或 MIT 授权素材。安装包附带 `assets/THIRD-PARTY-NOTICES.txt`。

## 历史 PNG 测试图片

- 文件：`tests/fixtures/preview-large.png`
- 方式：内置 `imagegen` 工具生成，原图直接保存，未二次绘制。
- 内容：树叶与枝干围绕蓝天白云，斑驳日光、自然绿色和可见油画笔触。
- 用途：保留给大尺寸 PNG 预览自动化测试，不再作为主题素材，不打入应用。旧山青蓝/西野红的 SVG 背景已移除。

### 历史测试图片的生成提示词

```text
Use case: stylized-concept. Asset type: a high-resolution landscape 16:9 desktop background painting, ideally 2560 by 1440 pixels, with no interface. Create a luminous impressionist oil painting of looking upward through gently swaying leafy trees toward a beautiful natural blue sky with soft white cumulus clouds. The desired feeling is sunlight and dappled shade beneath trees, with distinct leaf clusters and slender dark branches framing openings of sky; recognizable trees, sky and clouds, not a blue-green abstract blend. Leafy boughs enter from the upper left and side edges, with a looser canopy across the lower edge. Leave a generous calm opening of blue sky and drifting white clouds through the center and upper right. Use expressive visible oil brushstrokes, layered pigment, subtle canvas texture, natural plant greens ranging from warm sunlit sap green to cool forest-green shadow, clear cerulean and azure sky, warm creamy cloud highlights. Balanced airy composition, peaceful summer daylight, subtle sense of a breeze, painterly rather than photorealistic. This painting will sit behind translucent glass terminal panels in a desktop application, so prefer medium-scale readable forms and a calm center over fussy tiny detail. Keep the painting naturally bright; the application will add its own readability tint. No people, no buildings, no mountains, no roads, no text, no logos, no borders, no fake UI, no neon colors, no smooth gradient wallpaper.
```
