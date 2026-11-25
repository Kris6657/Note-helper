# Note-helper

**点中文笔记里的页码，旁边的 PDF 就跳到课件原页。** Note-helper 是一个本地复习工具，左边放课件，右边放提前准备好的 Markdown 笔记。读到一个公式、图表或结论时，可以直接翻回原文核对，读完再标出自己容易忘的地方。

## 为什么做这个项目

幕布的大纲和思维导图适合梳理笔记结构。如果一门课有好几份 PDF 和笔记，Note-helper 会按课程和模块把它们配对，方便复习时查阅图表、公式和原文。

例如，演示笔记算出了第 2 周订单数增长 25%。点标题旁的 `P2`，左栏跳到第 2 页，可以对照课件里的 80 单和 100 单，确认增长率用 80 做分母。记不牢的话，给这页加星标，或在对应的笔记块留一句提醒，下次复习时再看。[演示笔记](examples/演示课程/Module%201/notes.md) · [三页英文课件](examples/演示课程/Module%201/slides.pdf)

## 快速开始

**Windows 源码运行**需要 Python 3.8+ 和浏览器。阅读服务只用 Python 标准库，前端无需安装 npm 或执行构建。首次准备资源时需要联网，资源备齐后可以离线复习。在解压后的项目根目录打开 PowerShell。

1. **准备前端资源。** 如果 Windows 上使用的是 `py` 启动器，将本步的 `python` 换成 `py -3`。脚本从 npm 官方仓库获取固定版本的 PDF.js 和 marked，并检查 SHA-256。[资源清单](vendor-manifest.json)

   ```powershell
   python tools/prepare_vendor.py --download
   ```

2. **复制自制演示课程。** 下列命令会跳过已有的演示目录，便于保留上次体验做过的批注。

   ```powershell
   if (-not (Test-Path -LiteralPath '.\courses\演示课程')) {
       New-Item -ItemType Directory -Path '.\courses' -Force | Out-Null
       Copy-Item -LiteralPath '.\examples\演示课程' -Destination '.\courses\演示课程' -Recurse
   }
   ```

3. **启动阅读器。** 浏览器会自动打开。若未打开，访问终端显示的本机地址。

   ```powershell
   .\start.bat
   ```

在左上角选「演示课程 · Module 1」，点笔记里的 `P2`，确认左栏页码框显示 `2`。再给第 2 页加星标，切到「批注」模式，点笔记块写一条评论。按 `Ctrl+S`，等到「已保存」后刷新，星标和评论应仍在。关掉终端即可停止服务。

如果点 `P2` 后页码框显示末页，点课件栏的 `+` 放大课件后再试。窗口较高时，短课件容易在跳页时滚到最底部。

**Windows x64 便携版**可从 GitHub Releases 下载。把预览版 ZIP 完整解压到可写目录，双击 `Note-helper.exe`，即可打开自带的演示课程。便携预览目前未签名。[GitHub Releases](https://github.com/Kris6657/Note-helper/releases) · [便携版说明](便携版说明.md)

## 加入自己的课件

在 `courses/` 下以课程名建文件夹，再按模块放入 PDF 和 Markdown。文件名固定，模块名采用 `Module 1`，也支持 `Module_1` 和 `Module1`。

```text
courses/
└─ 我的课程/
   └─ Module 1/
      ├─ slides.pdf
      └─ notes.md
```

从 PDF 文件的首页开始数页码，在笔记标题或段落里写上对应的页码。打开阅读器后，标题里的 `（P2）` 会显示为可点击的页码标签。

```markdown
## 比较时保持统计范围一致（P2）

- 绝对变化是 20 单，相对变化是 25%。
- 算增长率时，用起点的 80 单做分母。
```

连续页写成 `（P7–P15）`，分开的页写成 `（P11、P14）`。后续笔记块可以继承最近的页码。引用同一课程的另一个模块时，写 `[[Module 2]]`。

笔记可以手写，也可以用外部工具生成后保存为 Markdown。如果用 AI 整理，先确认课件可以发送给所选服务。[笔记生成提示词](tools/笔记生成提示词.md)

## 复习与数据

- **按页回看。** 星标用来标自己要重看的页，旗帜用来标课程重点。页筛选只作用于当前模块，并保留 PDF 的原始页码。开启「同步滚动」后，两栏会跟随笔记里的页码滚动。
- **按知识点复习。** 切到「批注」即可对段落、列表项或表格行标色、写评论。掌握进度按 Markdown 标题统计，可切换统计层级。按 `Ctrl+K` 搜索右侧笔记。PDF 栏按页绘制，文字搜索限于笔记栏。
- **带走学习记录。** `slides.pdf` 和 `notes.md` 以只读方式打开。评论、颜色、掌握进度、星标和旗帜保存在模块目录的 `annotations.json`。换电脑、升级或改写笔记前，先退出程序并备份整个 `courses/`。改写笔记后，程序会用内容指纹尝试匹配原批注，无法唯一匹配的条目会单独保留并提醒。

## 常见问题

| 现象 | 怎么处理 |
|---|---|
| 找不到 Python | 先运行 `python --version` 或 `py -3 --version`。如果启动脚本仍找不到解释器，可以在项目根目录的 `python-path.txt` 里单独一行填入 `python.exe` 的绝对路径。 |
| 启动时报资源缺失或校验失败 | 运行 `python tools/prepare_vendor.py --check` 和 `.\start.bat --check` 定位问题。文件缺失可按快速开始补齐。校验失败时先保留原文件，另在干净目录中准备资源。 |
| 打开后看不到演示课程 | 检查课件和笔记是否位于 `courses/演示课程/Module 1/`。`examples/` 是演示原件的位置。 |
| PDF 空白或显示异常 | 用终端显示的地址访问 `/selftest.html`，查看 PDF 加载、渲染与前端资源检查结果。 |
| 批注未保存、提示冲突或文件损坏 | 先留在当前页面并复制尚未保存的评论。冲突时重新载入后核对再编辑。文件损坏时保留原文件，从备份核对。 |

<details>
<summary>离线准备资源、PDF 辅助工具与便携版构建</summary>

已有固定版本的 `.tgz` 包时，可以在离线环境中准备前端资源。将下例中的「包目录」换成实际路径。

```powershell
python tools/prepare_vendor.py --archive "pdfjs-dist=包目录/pdfjs-dist-6.4.299.tgz" --archive "marked=包目录/marked-12.0.2.tgz"
```

PDF 辅助工具用于提取带页码的文本或把指定页渲染成图。仅在使用它们时，在 Python 3.10+ 环境中安装 [requirements-tools.txt](requirements-tools.txt)。

```powershell
python -m pip install -r requirements-tools.txt
```

便携包构建已在 Windows x64、Python 3.13 和 PowerShell 7 上验证。先准备前端资源，再从项目根目录执行以下命令。产物写入本地 `dist/`。

```powershell
python -m venv .venv-build
.\.venv-build\Scripts\python.exe -m pip --isolated --disable-pip-version-check install --no-cache-dir --require-hashes --index-url https://pypi.org/simple -r requirements-build.txt
.\tools\build_windows.ps1
```

</details>

## 反馈与许可

用自制演示复现问题，附上启动环境、操作步骤和实际结果。提交前请检查示例与截图是否适合公开。[贡献指南](CONTRIBUTING.md) · [设计与已验证范围](规格说明.md#验证范围与发布边界)

项目代码与自制示例采用 MIT 许可证。分发时请保留所含组件的许可声明。[MIT 许可证](LICENSE) · [第三方组件声明](THIRD_PARTY_NOTICES.md)
