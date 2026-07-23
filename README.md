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

- 🧭アーキテクト（設計・計画のみ）／🛠️エンジニア（実装・コミット）／🔍レビュアー
  （コードレビューのみ）の3役割。それぞれ `~/.claude/agents/` に汎用ペルソナとして定義されています
  （プロジェクト内ではなくユーザーレベルなので、どのディレクトリを対象にしても認識されます）
- 使い方: 「組織図」タブ上部の「対象プロジェクト」欄に作業ディレクトリのパスを入力し
  （過去にFleetViewが観測したプロジェクトは候補に出ます）、各役割カードのテキストエリアに
  やってほしいことを自由文で書いて「起動する」を押すだけです
- 起動されたエージェントはバックグラウンドで動き、対象プロジェクトに hooks 設定さえ
  あれば（グローバル設定なので通常は自動的に）「プロセス」タブにも表示されます
- アーキテクト・レビュアーは実装やコミットをしない前提のペルソナです（Read/Bash/Grep/Glob
  のみ許可）。エンジニアは実装・コミットまで行います（pushはしないようペルソナに明記）

## 今後の拡張候補

1. **セルフモニタリング** — このダッシュボード自体の開発を行う Claude Code
   セッションも、当然このダッシュボードに表示されます（自己観測ループ）。
2. **チーム利用への拡張** — 将来的に複数人・複数マシンで使いたくなった場合は、
   サーバーをクラウド（Cloudflare Workers + Durable Objects 等）に載せ替える形で
   拡張できるよう、REST/WebSocket の境界を意識して設計してあります。
