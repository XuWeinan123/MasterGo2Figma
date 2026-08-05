import * as React from "react"
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  FileArchive,
  FileUp,
  Loader2,
  X,
} from "lucide-react"

import { Button } from "./components/ui/button"
import { Checkbox } from "./components/ui/checkbox"
import { Progress } from "./components/ui/progress"
import { Switch } from "./components/ui/switch"
import * as engine from "./engine"

type View = "idle" | "parsed" | "importing" | "success" | "error" | "lab"

interface PageItem {
  id: string
  name: string
  displayName: string
  layerCount: number
}

interface FileInfo {
  fileNames: string[]
  pageCount: number
  layerCount: number
  pages: PageItem[]
}

interface ProgressState {
  percent: number
  stage: string
  layersDone: number
  layersTotal: number
}

interface ResultState {
  pageCount: number
  layerCount: number
  details: string[]
}

interface ErrorState {
  kind: "read" | "import"
  message: string
  pagesDone: number
  pagesTotal: number
}

const HELP_URL = "https://github.com/XuWeinan123/MasterGo2Figma/issues"

export function App() {
  const [view, setView] = React.useState<View>("idle")
  const [prevView, setPrevView] = React.useState<View>("idle")
  const [zipEnabled, setZipEnabled] = React.useState(false)
  const [parsing, setParsing] = React.useState(false)
  const [dropHint, setDropHint] = React.useState<string | null>(null)
  const [dragOver, setDragOver] = React.useState(false)
  const [fileInfo, setFileInfo] = React.useState<FileInfo | null>(null)
  const [selected, setSelected] = React.useState<Set<string>>(new Set())
  const [progress, setProgress] = React.useState<ProgressState>({
    percent: 0,
    stage: "prepare",
    layersDone: 0,
    layersTotal: 0,
  })
  const [result, setResult] = React.useState<ResultState | null>(null)
  const [error, setError] = React.useState<ErrorState | null>(null)
  const [showDetails, setShowDetails] = React.useState(false)
  const [fontBusy, setFontBusy] = React.useState(false)
  const [fontMsg, setFontMsg] = React.useState<string | null>(null)

  const fileInputRef = React.useRef<HTMLInputElement>(null)
  const viewRef = React.useRef(view)
  viewRef.current = view
  const pagesDoneRef = React.useRef(0)
  const pagesTotalRef = React.useRef(0)

  React.useEffect(() => {
    engine.initEngine({
      onProgress: (p: ProgressState) => {
        if (viewRef.current === "importing") setProgress(p)
      },
      onPageDone: (done: number) => {
        pagesDoneRef.current = done
      },
      onComplete: (r: ResultState) => {
        setResult(r)
        setShowDetails(false)
        setView("success")
      },
      onImportError: (message: string) => failImport(message),
      onRefreshFontsComplete: (text: string) => {
        setFontBusy(false)
        setFontMsg(text)
      },
    })
  }, [])

  function failImport(message: string) {
    if (viewRef.current !== "importing") return
    setError({
      kind: "import",
      message,
      pagesDone: pagesDoneRef.current,
      pagesTotal: pagesTotalRef.current,
    })
    setShowDetails(false)
    setView("error")
  }

  function handleFiles(list: FileList | null) {
    if (!list || list.length === 0 || parsing) return
    const files = Array.from(list)
    const unsupported = files.find((f) => !/\.(mg|zip)$/i.test(f.name))
    const hasZip = files.some((f) => /\.zip$/i.test(f.name))
    if (unsupported) {
      setDropHint(zipEnabled ? "仅支持 .mg 或 .zip 文件" : "仅支持 .mg 文件")
      return
    }
    if (hasZip && !zipEnabled) {
      setDropHint("ZIP 导入需要先在实验室中启用")
      return
    }
    void parseFiles(files)
  }

  async function parseFiles(files: File[]) {
    setParsing(true)
    setDropHint(null)
    try {
      const info = (await engine.parseFiles(files)) as FileInfo
      setFileInfo(info)
      setSelected(new Set(info.pages.map((p) => p.id)))
      setView("parsed")
    } catch (e: any) {
      setError({ kind: "read", message: String((e && e.message) || e), pagesDone: 0, pagesTotal: 0 })
      setShowDetails(false)
      setView("error")
    } finally {
      setParsing(false)
    }
  }

  function resetToIdle() {
    engine.resetPackage()
    setFileInfo(null)
    setSelected(new Set())
    setResult(null)
    setError(null)
    setDropHint(null)
    setShowDetails(false)
    setView("idle")
  }

  async function startImport() {
    const ids = fileInfo!.pages.map((p) => p.id).filter((id) => selected.has(id))
    if (ids.length === 0) return
    pagesDoneRef.current = 0
    pagesTotalRef.current = ids.length
    setProgress({ percent: 0, stage: "prepare", layersDone: 0, layersTotal: 0 })
    setView("importing")
    try {
      await engine.startImport(ids)
    } catch (e: any) {
      failImport(String((e && e.message) || e))
    }
  }

  function toggleAll(checked: boolean) {
    setSelected(checked ? new Set(fileInfo!.pages.map((p) => p.id)) : new Set())
  }

  function togglePage(id: string, checked: boolean) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (checked) next.add(id)
      else next.delete(id)
      return next
    })
  }

  function openLab() {
    setPrevView(view === "lab" ? "idle" : view)
    setFontMsg(null)
    setView("lab")
  }

  const accept = zipEnabled ? ".mg,.zip,application/zip" : ".mg"

  return (
    <div className="flex h-screen w-full flex-col">
      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept={accept}
        className="hidden"
        onChange={(e) => {
          handleFiles(e.target.files)
          e.target.value = ""
        }}
      />

      <main className="flex min-h-0 flex-1 flex-col gap-3 p-4">
        {view === "idle" && (
          <IdleView
            zipEnabled={zipEnabled}
            parsing={parsing}
            dropHint={dropHint}
            dragOver={dragOver}
            setDragOver={setDragOver}
            onDropFiles={handleFiles}
            onPick={() => fileInputRef.current?.click()}
          />
        )}

        {view === "parsed" && fileInfo && (
          <ParsedView
            fileInfo={fileInfo}
            selected={selected}
            onToggleAll={toggleAll}
            onTogglePage={togglePage}
            onRemove={resetToIdle}
            onImport={() => void startImport()}
          />
        )}

        {view === "importing" && <ImportingView progress={progress} />}

        {view === "success" && result && (
          <ResultView
            result={result}
            showDetails={showDetails}
            onToggleDetails={() => setShowDetails((v) => !v)}
            onDone={() => engine.closePlugin()}
            onRestart={resetToIdle}
          />
        )}

        {view === "error" && error && (
          <>
            {fileInfo && error.kind === "import" && <FileRow fileInfo={fileInfo} />}
            <ErrorView
              error={error}
              showDetails={showDetails}
              onToggleDetails={() => setShowDetails((v) => !v)}
              onRestart={resetToIdle}
            />
          </>
        )}

        {view === "lab" && (
          <LabView
            zipEnabled={zipEnabled}
            onZipEnabledChange={(v) => {
              setZipEnabled(v)
              setDropHint(null)
            }}
            fontBusy={fontBusy}
            fontMsg={fontMsg}
            onRefreshFonts={() => {
              setFontBusy(true)
              setFontMsg(null)
              engine.refreshFonts()
            }}
            onBack={() => setView(prevView)}
          />
        )}
      </main>

      {(view === "idle" || view === "parsed" || view === "importing" || view === "success" || view === "error") && (
        <footer className="flex h-10 shrink-0 items-center justify-between border-t px-4 text-[11px] text-muted-foreground">
          <div className="flex items-center gap-3">
            <button
              className="hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
              disabled={view === "importing"}
              onClick={openLab}
            >
              实验室
            </button>
            <span aria-hidden>·</span>
            <a className="hover:text-foreground" href={HELP_URL} target="_blank" rel="noreferrer">
              Github（禁止未署名二次分发）
            </a>
          </div>
          <span>v1.0</span>
        </footer>
      )}
    </div>
  )
}

function IdleView(props: {
  zipEnabled: boolean
  parsing: boolean
  dropHint: string | null
  dragOver: boolean
  setDragOver: (v: boolean) => void
  onDropFiles: (files: FileList | null) => void
  onPick: () => void
}) {
  const { zipEnabled, parsing, dropHint, dragOver, setDragOver, onDropFiles, onPick } = props
  const typeText = zipEnabled ? ".mg 或 .zip" : ".mg"
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div
        className={
          "flex min-h-0 flex-1 cursor-pointer flex-col items-center justify-center gap-3 rounded-lg border-2 border-dashed transition-colors " +
          (dragOver ? "border-primary bg-accent" : "border-border hover:border-primary/50 hover:bg-accent/50")
        }
        onClick={() => !parsing && onPick()}
        onDragOver={(e) => {
          e.preventDefault()
          if (!parsing) setDragOver(true)
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault()
          setDragOver(false)
          if (!parsing) onDropFiles(e.dataTransfer.files)
        }}
      >
        {parsing ? (
          <>
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            <div className="text-sm font-medium">正在解析文件…</div>
          </>
        ) : (
          <>
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-secondary">
              <FileUp className="h-6 w-6 text-secondary-foreground" />
            </div>
            <div className="text-sm font-medium">拖入 {typeText} 文件</div>
            <Button
              variant="secondary"
              size="sm"
              onClick={(e) => {
                e.stopPropagation()
                onPick()
              }}
            >
              选择文件
            </Button>
          </>
        )}
      </div>
      {dropHint && (
        <div className="flex items-center gap-1.5 text-xs text-destructive">
          <AlertCircle className="h-3.5 w-3.5 shrink-0" />
          {dropHint}
        </div>
      )}
    </div>
  )
}

function FileRow({ fileInfo, onRemove }: { fileInfo: FileInfo; onRemove?: () => void }) {
  const fileLabel =
    fileInfo.fileNames.length === 1 ? fileInfo.fileNames[0] : `${fileInfo.fileNames.length} 个文件`
  return (
    <div className="flex h-11 shrink-0 items-center gap-2 rounded-lg border pl-3 pr-2">
      <FileArchive className="h-4 w-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate text-sm font-medium" title={fileInfo.fileNames.join("\n")}>
        {fileLabel}
      </span>
      {onRemove && (
        <Button variant="ghost" size="icon" className="h-7 w-7" title="移除文件" onClick={onRemove}>
          <X />
        </Button>
      )}
    </div>
  )
}

function ParsedView(props: {
  fileInfo: FileInfo
  selected: Set<string>
  onToggleAll: (checked: boolean) => void
  onTogglePage: (id: string, checked: boolean) => void
  onRemove: () => void
  onImport: () => void
}) {
  const { fileInfo, selected, onToggleAll, onTogglePage, onRemove, onImport } = props
  const allChecked =
    selected.size === fileInfo.pages.length ? true : selected.size === 0 ? false : ("indeterminate" as const)

  return (
    <>
      <FileRow fileInfo={fileInfo} onRemove={onRemove} />

      <div className="text-xs text-muted-foreground">
        已读取 · {fileInfo.pageCount} 个页面 · {fileInfo.layerCount} 个图层
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border">
        <div
          className="flex h-10 shrink-0 cursor-pointer items-center gap-2.5 border-b bg-muted/40 px-3"
          onClick={() => onToggleAll(allChecked !== true)}
        >
          <Checkbox
            checked={allChecked}
            onClick={(e) => e.stopPropagation()}
            onCheckedChange={(checked) => onToggleAll(checked === true)}
          />
          <span className="flex-1 text-sm">全选</span>
          <span className="text-xs text-muted-foreground">已选 {selected.size} 页</span>
        </div>
        <div className="min-h-0 flex-1 divide-y overflow-y-auto">
          {fileInfo.pages.map((page) => (
            <div
              key={page.id}
              className="flex h-10 cursor-pointer items-center gap-2.5 px-3 hover:bg-accent/50"
              onClick={() => onTogglePage(page.id, !selected.has(page.id))}
            >
              <Checkbox
                checked={selected.has(page.id)}
                onClick={(e) => e.stopPropagation()}
                onCheckedChange={(checked) => onTogglePage(page.id, checked === true)}
              />
              <span className="min-w-0 flex-1 truncate text-sm" title={page.name}>
                {page.displayName}
              </span>
              <span className="text-xs tabular-nums text-muted-foreground">{page.layerCount}</span>
            </div>
          ))}
        </div>
      </div>

      <Button className="w-full" disabled={selected.size === 0} onClick={onImport}>
        {selected.size === 0 ? "请选择页面" : `导入 ${selected.size} 个页面`}
      </Button>
    </>
  )
}

function ImportingView({ progress }: { progress: ProgressState }) {
  const statusLine = (() => {
    if (progress.stage === "assets") return "正在打包图片"
    if (progress.stage === "pageSend") return "正在发送页面数据"
    if (progress.stage === "restore" || progress.stage === "postprocess") {
      return `正在导入 · ${progress.layersDone}/${progress.layersTotal}`
    }
    if (progress.stage === "finalize") return "即将完成"
    return "正在准备"
  })()

  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 rounded-lg border px-8">
      <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      <div className="w-full truncate text-center text-sm font-medium" title={statusLine}>
        {statusLine}
      </div>
      <Progress value={progress.percent} />
      <div className="text-xs tabular-nums text-muted-foreground">{progress.percent}%</div>
    </div>
  )
}

function ResultView(props: {
  result: ResultState
  showDetails: boolean
  onToggleDetails: () => void
  onDone: () => void
  onRestart: () => void
}) {
  const { result, showDetails, onToggleDetails, onDone, onRestart } = props
  return (
    <>
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 overflow-y-auto rounded-lg border px-6 text-center">
        <CheckCircle2 className="h-8 w-8 text-green-600" />
        <div className="text-sm font-medium">
          导入完成 · {result.pageCount} 个页面 · {result.layerCount} 个图层
        </div>
        {result.details.length > 0 && (
          <div className="text-xs text-muted-foreground">
            <button className="inline-flex items-center gap-0.5 hover:text-foreground" onClick={onToggleDetails}>
              {showDetails ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
              查看详情
            </button>
            {showDetails && (
              <ul className="mt-1.5 space-y-0.5 text-left">
                {result.details.map((d, i) => (
                  <li key={i}>{d}</li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
      <div className="flex w-full flex-col gap-2">
        <Button className="w-full" onClick={onDone}>
          完成
        </Button>
        <Button variant="ghost" className="w-full" onClick={onRestart}>
          重新导入
        </Button>
      </div>
    </>
  )
}

function ErrorView(props: {
  error: ErrorState
  showDetails: boolean
  onToggleDetails: () => void
  onRestart: () => void
}) {
  const { error, showDetails, onToggleDetails, onRestart } = props
  const isRead = error.kind === "read"
  return (
    <>
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 overflow-y-auto rounded-lg border px-6 text-center">
        <AlertCircle className="h-8 w-8 text-destructive" />
        <div className="text-sm font-medium">
          {isRead ? "无法读取文件" : `导入失败 · 已完成 ${error.pagesDone} / ${error.pagesTotal} 个页面`}
        </div>
        <div className="text-xs text-muted-foreground">
          {isRead ? "文件可能已损坏或格式不受支持" : "可重新导入，已导入的页面不受影响"}
        </div>
        <div className="text-xs text-muted-foreground">
          <button className="inline-flex items-center gap-0.5 hover:text-foreground" onClick={onToggleDetails}>
            {showDetails ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
            查看详情
          </button>
          {showDetails && (
            <div className="mt-1.5 max-h-24 overflow-y-auto whitespace-pre-wrap break-all rounded-md bg-muted p-2 text-left">
              {error.message}
            </div>
          )}
        </div>
      </div>
      <Button className="w-full" onClick={onRestart}>
        {isRead ? "重新选择文件" : "重新导入"}
      </Button>
    </>
  )
}

function LabView(props: {
  zipEnabled: boolean
  onZipEnabledChange: (v: boolean) => void
  fontBusy: boolean
  fontMsg: string | null
  onRefreshFonts: () => void
  onBack: () => void
}) {
  const { zipEnabled, onZipEnabledChange, fontBusy, fontMsg, onRefreshFonts, onBack } = props
  return (
    <div className="flex flex-1 flex-col gap-4">
      <div className="flex items-center gap-1">
        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onBack} title="返回">
          <ChevronLeft />
        </Button>
        <span className="text-sm font-semibold">实验室</span>
      </div>

      <div className="text-xs text-muted-foreground">
        实验功能可能不稳定，使用前建议保留原始文件。
      </div>

      <div className="rounded-lg border p-3">
        <div className="flex items-center justify-between gap-3">
          <div className="text-sm font-medium">启用 ZIP 导入</div>
          <Switch checked={zipEnabled} onCheckedChange={onZipEnabledChange} />
        </div>
        <div className="mt-1.5 text-xs text-muted-foreground">
          允许主界面选择和拖入 .zip 文件。该功能可能存在兼容性问题。
        </div>
      </div>

      <div className="rounded-lg border p-3">
        <div className="flex items-center justify-between gap-3">
          <div className="text-sm font-medium">字体工具</div>
          <Button variant="secondary" size="sm" disabled={fontBusy} onClick={onRefreshFonts}>
            {fontBusy && <Loader2 className="animate-spin" />}
            刷新字体
          </Button>
        </div>
        <div className="mt-1.5 text-xs text-muted-foreground">
          重新读取本机字体，仅在新安装字体未被识别时使用。
        </div>
        {fontMsg && <div className="mt-1.5 text-xs text-foreground">字体列表已刷新 · {fontMsg}</div>}
      </div>
    </div>
  )
}
