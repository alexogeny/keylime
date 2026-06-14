# keylime — Frontend API Contract

Derived from what the UI renders and the actions it fires. Read endpoints populate views; write endpoints back the buttons. `→` = response fields the UI binds.

**Conventions**
- JSON over HTTP. `:id` = path param. Money as strings (`"$0.34"`) or cents int — pick one, be consistent. Timestamps ISO 8601; UI shows relative.
- List endpoints return `{ items: [...], nextCursor? }`.
- Mutations return the updated resource (so the UI can reconcile without a refetch).
- Errors: `{ error: { code, message } }`. Known sentinel: `MODEL_SWITCH_INTERACTIVE_ONLY`.

---

## System / lifecycle

| Method | Route | Params | → Returns |
|---|---|---|---|
| GET | `/api/system` | — | `capabilities[]` (chat, memory, research, files, patches, models, approvals, tools, graph, runs, modelSwitch), `version` — **UI gates features on this** |
| GET | `/api/status` | — | `workspace`, `model`, `provider{name,status}`, `agentState` (idle\|thinking\|planning\|researching\|reading\|writing\|tooling\|waiting-approval\|retrying\|patching\|testing\|summarizing\|done), `tokens{used,max}`, `cost{today,cap}`, `counts{memory,research,tools,approvalsPending}` |
| GET | `/api/events` | `?since=` | **SSE/WebSocket stream**, not poll. Events: `agent.state`, `message.delta`, `tool.start/finish`, `approval.requested`, `patch.created`, `memory.updated`, `research.created`, `error`, `cost.updated` |

## Dashboard

| Method | Route | → Returns |
|---|---|---|
| GET | `/api/screens/dashboard` | `stats[]{label,value,sub}`, `threads[]{id,title,meta,state,time}`, `activity[]{label,text,time}`, `research[]{id,title,tags,time}`, `approvalsPending[]` |

## Chat

| Method | Route | Params | → Returns |
|---|---|---|---|
| GET | `/api/chat/threads` | `?q=` | `items[]{id,title,preview,state,time,counts}` |
| GET | `/api/chat/threads/:id` | — | `thread{...}`, `messages[]`, `pinned[]`, `bookmarks[]`, `runs[]` |
| POST | `/api/chat/threads` | `{title?}` | new `thread` |
| POST | `/api/chat/threads/:id/messages` | `{content, mode?, attachments[]?}` | accepted `message`; streamed reply via `/events` |
| POST | `/api/chat/threads/:id/interrupt` | — | cancels the in-flight turn (**steering**) |
| POST | `/api/chat/threads/:id/branch` | `{fromMessageId}` | new forked `thread` |
| PATCH | `/api/chat/threads/:id` | `{title?, archived?}` | `thread` |
| POST | `/api/chat/messages/:id/pin` | `{pinned}` | `message` |
| POST | `/api/chat/messages/:id/bookmark` | `{bookmarked}` | `message` |

**Message shape (UI renders by `role`):** `user | agent | tool | memory | research | file | error | approval | system`. Tool messages carry `{name,status,duration,tokensIn,tokensOut,cost,model,input,output}` for the expand panel.

## Research

| Method | Route | Params | → Returns |
|---|---|---|---|
| GET | `/api/research` | `?q=&tag=` | `items[]{id,title,tags,sources,claims,confidence,recency,backlinks}`, `facets` |
| GET | `/api/research/:id` | — | `title,tags,body(html),sources[]{n,title,host,confidence,url},related[],backlinks[],origin{threadId,toolCallId}` |
| DELETE | `/api/research/:id` | — | ok |
| POST | `/api/research/:id/pin` | `{pinned}` | entry |

## Memory

| Method | Route | Params | → Returns |
|---|---|---|---|
| GET | `/api/memory` | — | `profile[]{k,v,confidence,source,privacy}`, `timeline[]{t,text,tag}`, `entities[]{name,type,rel,facts,fresh}`, `relationships[]{subj,rel,obj,confidence}`, `projects[]{name,role,facts,status,note}`, `preferences[]{k,v,freq}`, `stats` |
| GET | `/api/memory/items` | `?q=` | flat `items[]` for search |
| POST | `/api/memory` | `{k,v,scope?}` | new item |
| PATCH | `/api/memory/:id` | `{v?,privacy?,pinned?,scope?,excluded?}` | item — covers edit / mark sensitive / pin / scope-to-workspace / exclude-from-chats |
| DELETE | `/api/memory/:id` | — | ok |

## Knowledge graph

| Method | Route | Params | → Returns |
|---|---|---|---|
| GET | `/api/graph` | — | `nodes[]{id,name,type,conns}`, `edges[]`, `clusters[]` |
| GET | `/api/graph/nodes/:id` | — | `node`, adjacency grouped: `memories[],chats[],research[],files[],people[],timeline[]` |
| POST | `/api/graph/edges` | `{from,rel,to}` | edge |
| DELETE | `/api/graph/edges/:id` | — | ok |

## Workspace / files

| Method | Route | Params | → Returns |
|---|---|---|---|
| GET | `/api/workspaces` | — | `items[]{id,name}`, `active` |
| POST | `/api/workspaces` | `{name}` | workspace |
| POST | `/api/workspaces/select` | `{id}` | active workspace |
| GET | `/api/workspace` | — | `instructions`, `activeContext[]`, `recent[]`, `modified[]`, `generated[]`, `attached[]`, `projectMemory[]` |
| GET | `/api/workspace/files` | `?path=` | `tree[]{id,name,depth,type,status}` (status: new\|mod\|ctx) |
| GET | `/api/workspace/files/:id` | — | `name,summary,content/diff,added,removed,writtenBy,createdAt` |
| POST | `/api/workspace/context` | `{fileId, action: add\|remove}` | updated `activeContext` |
| POST | `/api/workspace/files/:id/rollback` | — | ok |

## Tools

| Method | Route | Params | → Returns |
|---|---|---|---|
| GET | `/api/tools` | — | catalog `items[]{name,mode(auto\|ask\|blocked),calls,desc}` |
| PATCH | `/api/tools/:name` | `{mode}` | tool — changes permission |
| POST | `/api/tools/:name/invoke` | `{input}` | tool-call (direct invocation from command bar) |
| GET | `/api/tool-calls` | `?threadId=&tool=` | `items[]{id,name,status,thread,time,duration,tokens,cost,model}` |
| GET | `/api/tool-calls/:id` | — | full `{...,input,output,raw}` for inspector |

## Models

| Method | Route | Params | → Returns |
|---|---|---|---|
| GET | `/api/models` | — | `current`, `items[]{name,provider,ctx,costIn,costOut,latency,vision,tools,local,status,active}`, `fallbackChain[]`, `defaults` |
| POST | `/api/models/select` | `{name, workspaceScope?}` | model, **or** `MODEL_SWITCH_INTERACTIVE_ONLY` (UI shows "prompt" hint instead of a switch button) |
| PUT | `/api/models/fallback` | `{chain[]}` | fallbackChain |

## Approvals

| Method | Route | Params | → Returns |
|---|---|---|---|
| GET | `/api/approvals` | `?status=pending\|history` | `items[]{id,type(patch\|command\|file write\|network\|memory write\|tool call\|model switch),title,scope,risk,time,origin,detail,decision?}` |
| POST | `/api/approvals/:id/approve` | `{alwaysAllow?}` | approval |
| POST | `/api/approvals/:id/reject` | `{reason?}` | approval |
| POST | `/api/approvals/:id/request-changes` | `{note}` | approval |
| POST | `/api/approvals/:id/revoke` | — | reopens a historical decision |

## Patches

| Method | Route | Params | → Returns |
|---|---|---|---|
| GET | `/api/patches` | `?status=` | queue `items[]{id,title,files,added,removed,status(review\|tests-fail\|approved),origin}` |
| GET | `/api/patches/:id` | — | `files[]{name,added,removed,status}`, `diff[]{type,text}` per file, `explanation`, `checks{tests,lint}` |
| POST | `/api/patches/:id/approve` | — | patch (approve all) |
| POST | `/api/patches/:id/reject` | `{reason?}` | patch |
| POST | `/api/patches/:id/files/:fileId/approve` | — | file (granular) |
| POST | `/api/patches/:id/hunks/:hunkId/approve` | — | hunk (granular) |
| POST | `/api/patches/:id/rollback` | — | ok |

## Runs / activity

| Method | Route | Params | → Returns |
|---|---|---|---|
| GET | `/api/runs` | `?window=24h` | `items[]{id,prompt,model,status,duration,cost,tools,time}` |
| GET | `/api/runs/:id` | — | `{...meta, context, trace[]{icon,label,text}, finalOutput}` |
| POST | `/api/runs/:id/cancel` | — | run (**steering**) |
| POST | `/api/runs/:id/retry` | — | new run |

## Settings & providers

| Method | Route | Params | → Returns |
|---|---|---|---|
| GET | `/api/settings` | — | `profile`, `instructions`, `tone`, `privacy`, `memorySettings`, `modelSettings`, `toolPermissions[]`, `costLimits`, `theme`, `shortcuts`, `agentDefaults` |
| PATCH | `/api/settings` | `{any subset}` | settings |
| GET | `/api/providers` | — | `items[]{id,name,status,models}` |
| POST | `/api/providers/:id/connect` | `{apiKey}` | provider |
| POST | `/api/providers/:id/test` | — | `{ok,latency}` |
| DELETE | `/api/providers/:id` | — | ok |

## Cross-cutting

| Method | Route | Params | → Returns |
|---|---|---|---|
| GET | `/api/search` | `?q=` | unified `{threads[],research[],memory[],files[],entities[]}` — powers the ⌘K palette |
| POST | `/api/attachments` | multipart `file` | `{id,url,name,size}` for command-bar attach |

---

### Priority for backend (unlocks already-built UI)
1. `/api/events` stream — the spine; status bar + chat depend on it.
2. Approvals + patches writes — the most action-dense surfaces.
3. Run/turn steering (`interrupt`, `cancel`).
4. Memory + settings mutations.
5. `/api/search` + `/api/attachments`.

### Screen-bundle convenience routes (optional)
`/api/screens/{dashboard,chat/:id,research,memory,graph,workspace,activity,settings}` — each returns its view's data + available commands in one call, so a TUI pane doesn't fan out into many requests.
