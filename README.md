# FleetView — Claude Code セッション監視ダッシュボード

ローカルで常駐し、この PC 上で動く複数の Claude Code セッション（エージェント）の状態を
リアルタイムに可視化し、定期的な活動レポート（Markdown）を自動生成するツールです。

## 仕組み

```
Claude Code セッションA ─┐
Claude Code セッションB ─┼─ hooks (SessionStart/PreToolUse/...) ─▶ hooks/report-event.mjs
Claude Code セッションC ─┘                                              │
                                                                   POST /api/events
                                                                        ▼
                                                          server/index.js (Express + WebSocket)
                                                                        │
                                                          ┌─────────────┴─────────────┐
                                                          ▼                           ▼
                                                  data/state.json           web/ (ダッシュボード)
                                                  data/events.jsonl              ブラウザで閲覧
                                                          │
                                                          ▼
                                                  reports/*.md (定期レポート)
```

- 各 Claude Code セッションは、hooks（`SessionStart` `UserPromptSubmit` `PreToolUse`
  `PostToolUse` `Notification` `Stop` `SubagentStop` `SessionEnd`）が発火するたびに
  `hooks/report-event.mjs` を実行し、イベント内容をローカルサーバーへ送信します。
- サーバー未起動でもエラーにならず、hooks 自体は常に正常終了します（監視ツールが
  落ちていても Claude Code の動作に影響しません）。
- ダッシュボードは WebSocket でリアルタイム更新され、各セッションが「思考中」
  「ツール実行中」「入力待ち」などのステータスで表示されます。
- 1時間ごと（設定変更可）に自動でレポートを生成し、`reports/` に Markdown として保存します。
  ダッシュボードの「今すぐレポート生成」ボタンで手動生成も可能です。

## 起動方法

```
cd [作業フォルダのパス]
npm start
```

起動後、ブラウザで http://localhost:4317 を開いてください。

- `FLEETVIEW_PORT` 環境変数でポート変更可能（デフォルト 4317）
- `FLEETVIEW_REPORT_INTERVAL_MIN` 環境変数で自動レポート生成間隔（分）を変更可能（デフォルト 60、0で無効化）

サーバーを起動したままにしておくと、以降どの Claude Code セッションからの
イベントもリアルタイムで拾われます。PC起動時に自動で立ち上げたい場合はタスク
スケジューラへの登録も可能です（別途相談してください）。

## Claude Code との接続（hooks）

`~/.claude/settings.json`（グローバル設定）に、以下の8イベントそれぞれについて
`node "[作業フォルダのパス]\hooks\report-event.mjs"` を呼び出す
command hook を追加済みです:

`SessionStart` / `UserPromptSubmit` / `PreToolUse` / `PostToolUse` /
`Notification` / `Stop` / `SubagentStop` / `SessionEnd`

> **注意:** 設定ファイルは起動時に読み込まれるため、既に開いている Claude Code
> セッションには反映されません。**新しいセッションを開始するか、Claude Code を
> 再起動すると有効になります。**

設定内容は `hooks/settings-snippet.json` にも保存してあるので、他の設定ファイル
（プロジェクト単位の `.claude/settings.json` など）に個別に追加したい場合は
これをコピーしてください。

hooks を無効化したい場合は `~/.claude/settings.json` の `"hooks"` セクションを
削除するか、`disableAllHooks: true` を設定してください。

## ディレクトリ構成

```
server/        Express + WebSocket バックエンド
  index.js     APIルーティング・WebSocket配信・定期レポートのスケジューリング
  store.js     セッション状態のメモリ管理 + data/ への永続化
  report.js    レポート生成ロジック
hooks/
  report-event.mjs      Claude Code hooks から呼ばれる送信スクリプト
  settings-snippet.json 適用済みのhooks設定（コピー用の控え）
web/           ダッシュボードGUI（静的HTML/CSS/JS、ビルド不要）
data/          セッション状態・イベントログ（自動生成、gitには含めない想定）
reports/       生成された定期レポート（Markdown）
```

## 組織図（役割ベースのエージェント）

「組織図」タブから、**どのプロジェクトでも**役割（ペルソナ）ベースでエージェントを
起動できます。

- 部署ごとに役割がまとまっています（組織図では左から営業→開発→デザインの順に表示）:
  - **営業**: 🌐リサーチャー（Web調査・情報収集を行い調査メモを作成）／
    📊プレゼンター（調査メモ・与えられた情報をもとにスライド資料を作成）／
    📋議事録（メモ書きから議事録を作成）。
    プレゼンター自身はWeb調査は行わない（材料が足りなければリサーチャーへ依頼すべき旨を報告する）
  - **開発**: 🧭アーキテクト（設計・計画のみ）／🛠️エンジニア（実装・コミット）／
    🔍レビュアー（コードレビュー。脆弱性診断などセキュリティ観点のチェックもここに含む）／
    💡機能提案（より便利になる新機能の提案のみ）。アーキテクト・レビュアー・機能提案は
    実装やコミットをしない前提のペルソナです（Read/Bash/Grep/Glob/Skillのみ許可）
  - **デザイン**: 🎨LP（ランディングページのデザイン・実装）／🖥️システム
    （プロダクト・システム画面のデザイン・実装）。いずれも自己完結したHTML/CSSとして作成する
  - エンジニア・リサーチャー・プレゼンター・議事録・LP・システムは成果物（コード／資料）を
    保存してコミットまで行います（pushはしないようペルソナに明記）
- 各役割には専用のスキル（`.claude/skills/`）も紐づいています:
  `code-review-checklist`（レビュアー用。セキュリティ観点のチェック項目も含む）、
  `feature-design-doc`（アーキテクト用）、`implementation-workflow`（エンジニア用）、
  `feature-ideation`（機能提案用）、`web-research`（リサーチャー用）、
  `slide-deck-authoring`（プレゼンター用）、`meeting-minutes`（議事録用）、
  `lp-design`（LP用）、`system-ui-design`（システム用）
- 使い方: 「組織図」タブで、対象プロジェクトのディレクトリと、やってほしいことを自由文で
  書いて「起動する」を押すだけです。指示の内容（キーワード）から、どの役割が担当するか
  自動で振り分けられます（例:「レビューして」→レビュアー、「設計して」→アーキテクト、
  「調査して」→リサーチャー、「スライドにまとめて」→プレゼンター、「議事録を作って」→議事録、
  「脆弱性をチェックして」→レビュアー、「便利になる機能を提案して」→機能提案、
  「LPを作って」→LP、「システム画面をデザインして」→システム、それ以外→エンジニア）
- 起動されたエージェントはバックグラウンドで動き、対象プロジェクトに hooks 設定さえ
  あれば（グローバル設定なので通常は自動的に）「プロセス」タブにも表示されます
- **直接ターミナルから`claude`に指示した場合も反映**: 組織図の「起動する」ボタンを
  経由せず、対象プロジェクトで直接`claude`に指示した場合でも、`hooks/suggest-role.mjs`
  （`UserPromptSubmit`フック）が入力内容を上記と同じキーワードで判定し、
  (1) 該当する役割のスキルを参考にするよう追加コンテキストを提示、
  (2) そのセッションを組織図上でも該当ロールとして紐づける（`agent_type`をタグ付けする
  イベントをFleetViewに送信する）、の2つを行います。既に`--agent`で明示的にペルソナが
  指定されているセッションや、キーワードにヒットしない指示（デフォルトの「エンジニア」
  扱いになるもの）では何もしません。実際にそのロールの振る舞いに従うかどうかは
  Claude側の判断に委ねられる点は変わりません（あくまで振る舞いへの後押しであり強制ではない）

**セットアップ:** ペルソナ・スキルの実体は `.claude/agents/` `.claude/skills/`
としてこのリポジトリにコミットされています（gitで共有・持ち運び可能）。ただし
Claude Codeは「対象プロジェクトの `.claude/`」しか見ないため、**別のプロジェクトを
対象に組織図から起動するには、これらをユーザーレベル（`~/.claude/`）にも配置する
必要があります**。以下を一度実行してください（このリポジトリの `.claude/` を編集した
後も再実行してください）:

```
npm run sync-agents
```

## 今後の拡張候補

1. **チーム利用への拡張** — 将来的に複数人・複数マシンで使いたくなった場合は、
   サーバーをクラウド（Cloudflare Workers + Durable Objects 等）に載せ替える形で
   拡張できるよう、REST/WebSocket の境界を意識して設計してあります。
