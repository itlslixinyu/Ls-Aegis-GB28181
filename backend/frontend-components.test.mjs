import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { compileFunction } from "node:vm";
import { parse } from "vue/compiler-sfc";
import ts from "typescript";
import * as vue from "vue";
import { ApiError } from "../frontend/src/api.ts";
import * as userProfile from "../frontend/src/user-profile.ts";
import * as videoThumbnail from "../frontend/src/video-thumbnail.ts";
import * as archiveTimeline from "../frontend/src/archive-timeline.ts";
import * as archiveProbePool from "../frontend/src/archive-probe-pool.ts";
import * as archiveDurationCache from "../frontend/src/archive-duration-cache.ts";
import * as recordRange from "../frontend/src/record-range.ts";
import * as channelSearch from "../frontend/src/channel-search.ts";
import * as aiTypes from '../frontend/src/ai-types.ts';

const thumbnailCache = {
  readThumbnails: async () => ({}),
  saveThumbnail: async () => true,
  clearAccountThumbnails: async () => {},
};

test('告警原图重分析发送显式重试标志，受理后清空旧结果，迟到响应不覆盖其他告警',async t=>{
 const calls=[];let release;
 const {state:s}=component(t,'Alarms.vue',async(path,method,data)=>{calls.push({path,method,data});return new Promise(r=>release=r);},['detail','detailError','submittingAnalysis','analyzeAlarm']);
 s.detail.value={id:'original',analysis:{id:'job',status:'succeeded',result:{summary:'旧结果'}}};s.detailError.value='旧错误';
 const work=s.analyzeAlarm(true);assert.equal(s.submittingAnalysis.value,true);assert.equal(s.detailError.value,'');assert.deepEqual(calls[0],{path:'/ai/alarm-analyses',method:'POST',data:{alarmId:'original',reanalyze:true}});
 await s.analyzeAlarm(true);assert.equal(calls.length,1);
 release({id:'job',status:'queued',result:null});await work;assert.equal(s.detail.value.analysis.status,'queued');assert.equal(s.detail.value.analysis.result,null);
 const late=s.analyzeAlarm(true);s.detail.value={id:'other',analysis:null};release({id:'job',status:'queued',result:null});await late;assert.equal(s.detail.value.id,'other');assert.equal(s.detail.value.analysis,null);
});

// Exercise actual script-setup handlers with Vue reactivity. DOM wiring is
// verified separately in the browser; these tests control response ordering.
function component(t, file, api, bindings, props = {}, media = {}) {
  const events = [],
    hooks = { mounted: [], unmounted: [] },
    scope = vue.effectScope();
  const source = parse(
    readFileSync(
      new URL("../frontend/src/components/" + file, import.meta.url),
      "utf8",
    ),
  ).descriptor.scriptSetup.content;
  const code = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  const require = (name) => {

    if (name === "vue")
      return {
        ...vue,
        onMounted: (fn) => hooks.mounted.push(fn),
        onUnmounted: (fn) => hooks.unmounted.push(fn),
      };
    if (name === "../api")
      return {
        api,
        ApiError,
        can:()=>true,
        currentUser: vue.ref({ id: "admin", role: "admin" }),
        messageOf: (e) => (e instanceof Error ? e.message : "请求失败"),
      };
    if (name === "../remember-filter")
      return { rememberFilter: (_key, fallback) => vue.ref(fallback) };
    if (name === "../user-profile") return userProfile;
    if (name === "../video-thumbnail") return videoThumbnail;
    if (name === "../archive-timeline") return archiveTimeline;
    if (name === "../archive-probe-pool") return archiveProbePool;
    if (name === "../archive-duration-cache") return archiveDurationCache;
    if (name === "../record-range") return recordRange;
    if (name === "../channel-search") return channelSearch;
    if (name === '../ai-types') return aiTypes;
    if (name === "../thumbnail-cache")
      return { ...thumbnailCache, ...media.thumbnailCache };
    if (
      file === "Trajectories.vue" &&
      ["leaflet", "leaflet/dist/leaflet.css", "../map-base"].includes(name)
    )
      return {};
    if (file === "LivePlayer.vue" && name === "mpegts.js")
      return {
        default: {
          getFeatureList: () => ({ mseLivePlayback: true }),
          ...media,
        },
      };
    if (file === "LivePlayer.vue" && name === "../fragmented-preview")
      return { openFragmentedPreview: media.openFragmentedPreview };
    if (file === "LivePlayer.vue" && name === "../platform-recovery")
      return {
        probePlatform: media.probePlatform || (async () => null),
        waitForPlatformRestart:
          media.waitForPlatformRestart || (async () => null),
      };
    throw Error("Unexpected dependency: " + name);
  };
  const state = scope.run(() =>
    compileFunction(code + "\nreturn {" + bindings.join(",") + "};", [
      "require",
      "exports",
      "defineProps",
      "defineEmits",
      "defineExpose",
    ])(
      require,
      {},
      () => props,
      () =>
        (...args) =>
          events.push(args),
      () => {},
    ),
  );
  t.after(() => {
    hooks.unmounted.forEach((fn) => fn());
    scope.stop();
  });
  return { state, hooks, events };
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((r, j) => {
    resolve = r;
    reject = j;
  });
  return { promise, resolve, reject };
}

test('AI配置保存后清除输入密钥，异步测试完成后更新真实状态',async t=>{
 const config={provider:'DeepSeek',baseUrl:'https://api.deepseek.com',version:2,enabled:true,model:'deepseek-flash',hasKey:true,timeoutSeconds:60,retentionDays:7,lastTest:{status:'passed',message:'合成图分析通过',checkedAt:'2026-11-07'}};const writes=[];
 const {state:s}=component(t,'AiModels.vue',async(path,method,data)=>{if(method==='PUT'){writes.push(data);return config;}return config;},['settings','apiKey','form','clearKey','save','testing','pollTest','message']);
 s.settings.value={...config,version:1};s.apiKey.value='unit-test-secret-not-real';await s.save();assert.equal(writes[0].apiKey,'unit-test-secret-not-real');assert.equal(writes[0].version,1);assert.equal(s.apiKey.value,'');assert.equal(JSON.stringify(s.settings.value).includes('unit-test-secret-not-real'),false);
 s.testing.value=true;await s.pollTest();assert.equal(s.testing.value,false);assert.equal(s.message.value,'合成图分析通过');
});

test('AI查询拒绝反向日期，图片检索沿用完成的参考图任务',async t=>{
 const calls=[];const {state:s}=component(t,'AiSearch.vue',async(path,method,data)=>{calls.push({path,method,data});if(path==='/ai/search')return {items:[],total:0,method:'图像与描述',truncated:false};return {id:'reference',status:'succeeded'};},['target','mode','reference','referenceId','from','to','search','error','results','busy']);
 s.from.value='2026-11-08T12:00';s.to.value='2026-11-07T12:00';await s.search();assert.match(s.error.value,/开始时间不能晚于结束时间/);assert.equal(calls.length,0);
 s.target.value='indexed';s.from.value='';s.to.value='';s.mode.value='image';s.reference.value={image:'data:image/jpeg;base64,test',name:'sample.jpg'};s.referenceId.value='completed-reference';await s.search();assert.equal(calls[0].data.referenceId,'completed-reference');assert.equal(calls.some(c=>c.path==='/ai/analyses'),false);assert.equal(s.busy.value,false);
});

test("任务分组明细忽略迟到响应，轮询沿用已提交筛选而非未查询输入", async (t) => {
  const requests=[];
  const {state:s}=component(t,'RecordingTaskGroups.vue',path=>{const d=deferred();requests.push({path,...d});return d.promise},['selection','groupDialog','day','query','appliedDay','appliedQuery','filterMembers','loadMembers','members','memberLoading']);
  s.selection.value={id:'g'};s.groupDialog.value={open:true};
  s.day.value='2026-10-07';s.query.value='通道1';const first=s.filterMembers();
  s.day.value='2026-10-08';s.query.value='通道2';const second=s.filterMembers();
  requests[1].resolve({items:[{channelId:'new'}],total:1});await second;
  requests[0].resolve({items:[{channelId:'old'}],total:1});await first;
  assert.equal(s.members.value[0].channelId,'new');
  s.day.value='2026-10-09';s.query.value='尚未查询';const poll=s.loadMembers();
  assert.match(requests[2].path,/date=2026-10-08/);assert.match(decodeURIComponent(requests[2].path),/q=通道2/);
  requests[2].resolve({items:[{channelId:'new'}],total:1});await poll;
});

test("任务分组撤权清除旧数据并关闭详情和文件播放器",async t=>{
  const {state:s}=component(t,'RecordingTaskGroups.vue',async()=>{throw new ApiError('分组不存在或无权访问',403)},['selection','groupDialog','members','memberTotal','detailDialog','videoDialog','loadMembers','memberError']);
  const closed=[];s.selection.value={id:'g'};s.groupDialog.value={open:true};s.members.value=[{channelId:'private'}];s.memberTotal.value=64;
  s.detailDialog.value={close:()=>closed.push('detail')};s.videoDialog.value={close:()=>closed.push('video')};
  await s.loadMembers();assert.equal(s.members.value.length,0);assert.equal(s.memberTotal.value,0);assert.deepEqual(closed,['detail','video']);assert.match(s.memberError.value,/无权访问/);
});

test("临时分组查询失败显示错误但不关闭正在播放的录像，恢复后更新列表",async t=>{
  let fails=true;
  const {state:s}=component(t,'RecordingTaskGroups.vue',async()=>{if(fails)throw new ApiError('临时查询失败',503);return {items:[{channelId:'restored'}],total:1}},['selection','groupDialog','members','detailDialog','videoDialog','loadMembers','memberError','detail','video']);
  const closed=[];s.selection.value={id:'g'};s.groupDialog.value={open:true};s.members.value=[{channelId:'c'}];
  s.detail.value={job:{id:'j',kind:'scheduled'},kind:'files'};s.video.value={name:'test.mp4',url:'/existing-file'};
  s.detailDialog.value={close:()=>closed.push('detail')};s.videoDialog.value={close:()=>closed.push('video')};
  await s.loadMembers();assert.match(s.memberError.value,/临时查询失败/);assert.deepEqual(closed,[]);assert.equal(s.video.value.name,'test.mp4');
  fails=false;await s.loadMembers();assert.equal(s.memberError.value,'');assert.equal(s.members.value[0].channelId,'restored');
});

test("独立导出权限失效时清除其详情快照，普通读取失败不误关录像",async t=>{
  let denied=false;
  const {state:s}=component(t,'RecordingTaskGroups.vue',async path=>{
    if(path.startsWith('/recording-task-groups'))return {items:[],total:0,stats:{groups:0,channels:0,recording:0,errors:0,files:0}};
    throw new ApiError('导出读取失败',denied?403:503);
  },['load','detail','video','detailDialog','videoDialog','downloadError']);
  const closed=[];s.detail.value={job:{id:'d',kind:'download'},kind:'files'};s.video.value={name:'download.mp4',url:'/existing-file'};
  s.detailDialog.value={close:()=>closed.push('detail')};s.videoDialog.value={close:()=>closed.push('video')};
  await s.load();assert.deepEqual(closed,[]);assert.equal(s.video.value.name,'download.mp4');
  denied=true;await s.load();assert.deepEqual(closed,['detail','video']);assert.equal(s.detail.value,null);assert.equal(s.video.value,null);
});

test("分组汇总读取失败清空旧页总数，临时失败不误关正在播放的录像",async t=>{
  const {state:s}=component(t,'RecordingTaskGroups.vue',async path=>{if(path.startsWith('/recording-task-groups'))throw new ApiError('汇总临时失败',503);return {items:[]}},['load','groups','total','stats','video','videoDialog','detailDialog','error']);
  const closed=[];s.groups.value=[{id:'old'}];s.total.value=32;s.stats.value={groups:32,channels:64,recording:1,errors:2,files:3};s.video.value={name:'still-playing.mp4',url:'/existing'};
  s.videoDialog.value={close:()=>closed.push('video')};s.detailDialog.value={close:()=>closed.push('detail')};
  await s.load();assert.equal(s.groups.value.length,0);assert.equal(s.total.value,0);assert.equal(s.stats.value.groups,0);assert.deepEqual(closed,[]);assert.equal(s.video.value.name,'still-playing.mp4');assert.match(s.error.value,/汇总临时失败/);
});

test("全天表单保存为次日零点，自定义时段、天数及分钟分段不被覆盖，兼容原60分钟值", async (t) => {
  const writes = [];
  const { state: s } = component(
    t,
    "RecordingCenter.vue",
    async (path, method, data) => {
      if (method === "POST" || method === "PUT") {
        writes.push(data);
        return { id: "new", ...data };
      }
      return { items: [] };
    },
    ["form", "allDay", "save", "edit"],
    { section: "plans" },
  );
  s.form.value = {
    name: "全天",
    deviceGroupId: "default",
    channelIds: ["c"],
    version: 0,
    days: [1],
    startTime: "09:00",
    endTime: "18:00",
    retentionDays: 30,
    segmentSeconds: 180,
    enabled: false,
  };
  await s.save();
  assert.equal(writes[0].startTime, "00:00");
  assert.equal(writes[0].endTime, "00:00");
  assert.equal(writes[0].retentionDays, 30);
  assert.equal(writes[0].segmentSeconds, 180);
  s.allDay.value = false;
  await s.save();
  assert.equal(writes[1].startTime, "09:00");
  assert.equal(writes[1].endTime, "18:00");
  s.edit({ id: "old", ...s.form.value, segmentSeconds: 3600 });
  assert.equal(s.form.value.segmentSeconds, 3600);
  assert.equal(s.allDay.value, false);
  s.edit();
  assert.equal(s.allDay.value, true);
  assert.equal(s.form.value.endTime, "00:00");
});

test("录像计划只读取规则列表，执行历史与文件留给录像任务", async (t) => {
  const calls = [];
  const { state: s } = component(
    t,
    "RecordingCenter.vue",
    async (path) => {
      calls.push(path);
      if (path !== "/recording-plan-groups") throw Error("计划页不应请求执行任务");
      return { items: [{ id: "p1", name: "测试规则", enabled: 1 }] };
    },
    ["load", "plans", "jobs", "executionSteps"],
    { section: "plans" },
  );
  await s.load();
  assert.deepEqual(calls, ["/recording-plan-groups"]);
  assert.equal(s.plans.value.length, 1);
  assert.equal(s.jobs.value.length, 0);
  const history = s.executionSteps({
    id: "export",
    status: "failed",
    createdAt: "2026-11-07T01:00:00Z",
    error: "媒体不可用",
    files: [],
  });
  assert.equal(history.length, 1);
  assert.equal(history[0].error, "媒体不可用");
});

test("分组计划搜索不清除已选通道，切组必须清空旧选择，避免跨组提交", (t) => {
  const {state:s}=component(t,"RecordingCenter.vue",async()=>({items:[]}),["form","channels","channelSearch","groupChannels","matchingGroupChannels","selectVisibleChannels","changeGroup"],{section:"plans"});
  s.channels.value=[{id:"a",groupId:"g",name:"大厅",channelCode:"001",deviceName:"NVR"},{id:"b",groupId:"g",name:"门口",channelCode:"002",deviceName:"NVR"},{id:"x",groupId:"other",name:"其他",channelCode:"003",deviceName:"NVR"}];
  s.form.value.deviceGroupId="g"; s.channelSearch.value="大厅";
  s.selectVisibleChannels(); assert.deepEqual(Array.from(s.form.value.channelIds),["a"]);
  s.channelSearch.value="002"; s.selectVisibleChannels(); assert.deepEqual(Array.from(s.form.value.channelIds),["a","b"]);
  s.channelSearch.value="不存在"; assert.equal(s.matchingGroupChannels.value.length,0); assert.equal(s.form.value.channelIds.length,2);
  s.form.value.deviceGroupId="other"; s.changeGroup(); assert.equal(s.form.value.channelIds.length,0); assert.equal(s.channelSearch.value,""); assert.equal(s.groupChannels.value[0].id,"x");
});

test("录像列表默认隐藏已删除通道，历史入口保留原文件归属且清理失效选择", async (t) => {
  const { state: s } = component(
    t,
    "RecordingCenter.vue",
    async () => ({ items: [] }),
    [
      "jobs",
      "visibleJobs",
      "showDeleted",
      "libraryChannels",
      "libraryChannel",
      "channelLabel",
      "fileUrl",
    ],
    { section: "library" },
  );
  const old = {
    id: "old-job",
    channelId: "deleted-device:34020000001310000002",
    channelName: null,
    kind: "scheduled",
    status: "succeeded",
    createdAt: "2026-11-05T00:00:00Z",
    files: [
      {
        id: "old-file",
        name: "00-00-00.mp4",
        date: "2026-11-05",
        jobId: "original-job",
      },
    ],
  };
  s.jobs.value = [
    old,
    {
      ...old,
      id: "active-job",
      channelId: "live-channel",
      channelName: "现有通道",
      files: [{ id: "live-file", name: "file.mp4", date: "2026-11-05" }],
    },
  ];
  assert.equal(s.visibleJobs.value.length, 1);
  assert.equal(s.libraryChannels.value.length, 1);
  s.showDeleted.value = 1;
  await vue.nextTick();
  assert.equal(s.visibleJobs.value.length, 2);
  assert.equal(s.channelLabel(old), "通道已删除 · 34020000001310000002");
  assert.equal(
    s.fileUrl(old, old.files[0]),
    "/api/v1/recording-jobs/original-job/files/old-file",
  );
  s.libraryChannel.value = old.channelId;
  s.showDeleted.value = 0;
  await vue.nextTick();
  assert.equal(s.libraryChannel.value, "live-channel");
  assert.equal(s.jobs.value.length, 2, "隐藏不删除历史文件");
});
const dialog = () => ({
  open: false,
  showModal() {
    this.open = true;
  },
  close() {
    this.open = false;
  },
});
const device = (id) => ({
  id,
  name: "[测试] " + id,
  deviceId: "34020000001320000001",
});

test("用户资料编辑：后打开用户的响应优先，旧响应不覆盖新表单", async (t) => {
  const first = deferred(),
    second = deferred();
  const { state: s } = component(
    t,
    "Administration.vue",
    (path) => (path === "/users/one" ? first.promise : second.promise),
    ["dialog", "openEdit", "editing", "fields", "editorReady"],
    { view: "users" },
  );
  s.dialog.value = dialog();
  const a = s.openEdit({ id: "one", username: "one", role: "viewer" }),
    b = s.openEdit({ id: "two", username: "two", role: "viewer" });
  second.resolve({
    id: "two",
    username: "two",
    role: "viewer",
    displayName: "第二人",
    version: 1,
  });
  await b;
  first.resolve({
    id: "one",
    username: "one",
    role: "viewer",
    displayName: "第一人",
    version: 0,
  });
  await a;
  assert.equal(s.editing.value.id, "two");
  assert.equal(s.fields.value.displayName, "第二人");
  assert.equal(s.editorReady.value, true);
});
test("前后端分批更新：角色接口尚未部署时保留原用户列表与资料功能", async (t) => {
  const { state: s } = component(
    t,
    "Administration.vue",
    async (path) => {
      if (path === "/roles") throw new ApiError("接口不存在", 404);
      return { items: [{ id: "admin", username: "admin", role: "admin" }] };
    },
    ["load", "users", "rolesAvailable", "loadError"],
    { view: "users" },
  );
  await s.load();
  assert.equal(s.users.value.length, 1);
  assert.equal(s.rolesAvailable.value, false);
  assert.equal(s.loadError.value, "");
});

test("角色变更后失效的用户角色筛选会清除，有效筛选保留", async (t) => {
  const { state: s } = component(
    t,
    "Administration.vue",
    async () => ({ items: [{ id: "viewer", name: "只读用户" }] }),
    ["load", "roleFilter"],
    { view: "users" },
  );
  s.roleFilter.value = "deleted-role";
  await s.load();
  assert.equal(s.roleFilter.value, "");
  s.roleFilter.value = "viewer";
  await s.load();
  assert.equal(s.roleFilter.value, "viewer");
});

test("角色编辑冲突保留草稿并阻止重复旧版本保存，显式重读后可继续", async (t) => {
  let writes = 0;
  const fresh = {
    id: "role",
    name: "其他窗口修改",
    description: "新说明",
    permissions: ["devices.view"],
    version: 2,
    builtin: 0,
  };
  const { state: s } = component(
    t,
    "RolesPanel.vue",
    async (_path, method) => {
      if (method) {
        writes++;
        throw new ApiError("角色已更新，请重新读取", 409, "ROLE_CONFLICT");
      }
      return { items: [fresh], catalog: [] };
    },
    [
      "open",
      "editor",
      "name",
      "save",
      "reloadRole",
      "editorReady",
      "selected",
      "formError",
    ],
  );
  s.editor.value = dialog();
  s.open({ ...fresh, name: "原角色", version: 1 });
  s.name.value = "未保存草稿";
  await s.save();
  assert.equal(s.name.value, "未保存草稿");
  assert.equal(s.editorReady.value, false);
  await s.save();
  assert.equal(writes, 1);
  await s.reloadRole();
  assert.equal(s.name.value, "其他窗口修改");
  assert.equal(s.selected.value.version, 2);
  assert.equal(s.editorReady.value, true);
  assert.equal(s.formError.value, "");
});

test("角色重读关闭后迟到结果不覆盖新角色，角色已删除时禁止保存", async (t) => {
  const pending = deferred();
  let deleted = false;
  const { state: s } = component(
    t,
    "RolesPanel.vue",
    () =>
      deleted ? Promise.resolve({ items: [], catalog: [] }) : pending.promise,
    [
      "open",
      "editor",
      "reloadRole",
      "editorClosed",
      "name",
      "selected",
      "editorReady",
      "formError",
    ],
  );
  s.editor.value = dialog();
  s.open({ id: "one", name: "第一角色", permissions: [] });
  const load = s.reloadRole();
  s.editor.value.close();
  s.editorClosed();
  s.open({ id: "two", name: "第二角色", permissions: [] });
  pending.resolve({
    items: [{ id: "one", name: "迟到角色", permissions: [] }],
    catalog: [],
  });
  await load;
  assert.equal(s.name.value, "第二角色");
  assert.equal(s.selected.value.id, "two");
  deleted = true;
  await s.reloadRole();
  assert.equal(s.editorReady.value, false);
  assert.match(s.formError.value, /已删除/);
});

test("账号授权保留服务端设备范围，手动从管理员改业务角色不沿用全部设备", async (t) => {
  const { state: s } = component(
    t,
    "UserAuthorization.vue",
    async (path) =>
      path === "/roles"
        ? {
            items: [
              {
                id: "admin",
                name: "系统管理员",
                permissions: ["devices.view"],
              },
              { id: "viewer", name: "只读用户", permissions: ["devices.view"] },
            ],
            catalog: [{ key: "devices.view", label: "设备查看" }],
          }
        : path === "/groups"
          ? { items: [] }
          : { roleId: "admin", scopeMode: "all", groupIds: [], version: 0 },
    ["load", "roleId", "scope", "permissionSummary"],
    { user: { id: "test" } },
  );
  await s.load();
  assert.equal(s.scope.value, "all");
  assert.equal(s.permissionSummary.value, "设备查看");
  s.roleId.value = "viewer";
  assert.equal(s.scope.value, "groups");
  s.roleId.value = "admin";
  assert.equal(s.scope.value, "all");
});

test("用户资料编辑：关闭弹窗后迟到结果不回填，读取失败不能提交旧资料", async (t) => {
  const pending = deferred();
  let writes = 0;
  const { state: s } = component(
    t,
    "Administration.vue",
    (_path, method) => {
      if (method) {
        writes++;
        return;
      }
      return pending.promise;
    },
    ["dialog", "openEdit", "editorClosed", "create", "fields", "editorReady"],
    { view: "users" },
  );
  s.dialog.value = dialog();
  const loading = s.openEdit({ id: "one", username: "one", role: "viewer" });
  await s.create();
  assert.equal(writes, 0);
  s.dialog.value.close();
  s.editorClosed();
  pending.resolve({
    id: "one",
    username: "one",
    role: "viewer",
    displayName: "迟到姓名",
    version: 0,
  });
  await loading;
  assert.equal(s.fields.value.displayName, "");
  assert.equal(s.editorReady.value, false);
});

test("个人资料：保存冲突保留草稿和错误，重新读取可恢复当前版本", async (t) => {
  let loads = 0;
  const { state: s, events } = component(
    t,
    "PersonalDetails.vue",
    async (_path, method) => {
      if (method === "PUT")
        throw new ApiError("资料已由其他页面更新", 409, "PROFILE_CONFLICT");
      return {
        user: {
          id: "admin",
          username: "admin",
          role: "admin",
          displayName: ++loads === 1 ? "当前姓名" : "其他页新姓名",
          version: loads - 1,
        },
      };
    },
    ["load", "save", "fields", "user", "saving", "error"],
  );
  await s.load();
  s.fields.value.displayName = "未保存草稿";
  await s.save();
  assert.equal(s.fields.value.displayName, "未保存草稿");
  assert.match(s.error.value, /其他页面更新/);
  assert.equal(s.saving.value, false);
  assert.deepEqual(events, [
    ["busy", true],
    ["busy", false],
  ]);
  await s.load();
  assert.equal(s.fields.value.displayName, "其他页新姓名");
  assert.equal(s.user.value.version, 1);
});

test("个人资料：关闭后迟到读取不回填，未读到资料不可保存", async (t) => {
  const pending = deferred();
  let writes = 0;
  const { state: s, hooks } = component(
    t,
    "PersonalDetails.vue",
    (_path, method) => {
      if (method) {
        writes++;
        return;
      }
      return pending.promise;
    },
    ["load", "save", "fields", "user"],
  );
  const loading = s.load();
  await s.save();
  assert.equal(writes, 0);
  hooks.unmounted.forEach((fn) => fn());
  pending.resolve({
    user: {
      id: "admin",
      username: "admin",
      role: "admin",
      displayName: "迟到信息",
    },
  });
  await loading;
  assert.equal(s.user.value, undefined);
  assert.equal(s.fields.value.displayName, "");
});

test("预览放大：保留全部槽位和播放器引用，重复操作还原布局", (t) => {
  const { state: s } = component(
    t,
    "Monitoring.vue",
    async () => ({ items: [], total: 0 }),
    [
      "slots",
      "active",
      "layout",
      "maximized",
      "toggleMaximize",
      "changeLayout",
    ],
  );
  s.slots.value[0] = { id: "one" };
  s.slots.value[3] = { id: "four" };
  const first = s.slots.value[0],
    fourth = s.slots.value[3];
  s.toggleMaximize(3);
  assert.equal(s.maximized.value, 3);
  assert.equal(s.active.value, 3);
  assert.equal(s.layout.value, 4);
  assert.equal(s.slots.value[0], first);
  assert.equal(s.slots.value[3], fourth);
  s.toggleMaximize(3);
  assert.equal(s.maximized.value, null);
  s.toggleMaximize(0);
  s.changeLayout(9);
  assert.equal(s.maximized.value, null);
});

test("播放器声音：默认静音、音量与开关联动，无音轨不可伪造开启", async (t) => {
  const { state: s, events } = component(
    t,
    "LivePlayer.vue",
    async () => {},
    [
      "ready",
      "video",
      "muted",
      "volume",
      "hasAudio",
      "toggleAudio",
      "setVolume",
      "enlarge",
    ],
    { canMaximize: true },
  );
  s.video.value = { muted: true, volume: 0.7 };
  s.ready.value = true;
  s.hasAudio.value = true;
  assert.equal(s.muted.value, true);
  await s.toggleAudio();
  assert.equal(s.video.value.muted, false);
  s.volume.value = 0;
  s.setVolume();
  assert.equal(s.muted.value, true);
  assert.equal(s.video.value.volume, 0);
  await s.toggleAudio();
  assert.equal(s.volume.value, 70);
  assert.equal(s.muted.value, false);
  s.hasAudio.value = false;
  s.muted.value = true;
  await s.toggleAudio();
  assert.equal(s.muted.value, true);
  s.enlarge();
  assert.deepEqual(events, [["toggle-maximize"]]);
});

function mediaFixture() {
  const players = [];
  return {
    players,
    Events: { MEDIA_INFO: "info", ERROR: "error" },
    createPlayer(source) {
      const listeners = new Map();
      const p = {
        source,
        destroyed: false,
        on: (event, fn) => listeners.set(event, fn),
        emit: (...args) => listeners.get("error")(...args),
        attachMediaElement() {},
        load() {},
        play: async () => {},
        destroy() {
          this.destroyed = true;
        },
      };
      players.push(p);
      return p;
    },
  };
}

test("H.265 回退保留当前观看地址，旧主码流的迟到错误不能切换新子码流", (t) => {
  const media = mediaFixture();
  const callbacks = [];
  media.openFragmentedPreview = (_video, _url, _info, fail) => {
    callbacks.push(fail);
    return { play: async () => {}, destroy() {} };
  };
  const { state: s } = component(
    t,
    "LivePlayer.vue",
    async () => {},
    [
      "attach",
      "video",
      "select(url) { playGeneration++; playUrl = url; viewing = {}; attach(); }",
    ],
    {},
    media,
  );
  s.video.value = { removeAttribute() {}, load() {} };
  s.select("http://localhost/main/stream.mp4");
  s.select("http://localhost/sub/stream.mp4");
  callbacks[0](Error("stale"));
  assert.equal(media.players.length, 0);
  callbacks[1](Error("decode"));
  callbacks[1](Error("duplicate"));
  assert.equal(media.players.length, 1);
  assert.equal(media.players[0].source.url, "ws://localhost/sub/stream.flv");
});

test("播放器不支持音频：先让解码器完成错误回调及微任务，再只重建一次视频播放器", async (t) => {
  const media = mediaFixture();
  const { state: s } = component(
    t,
    "LivePlayer.vue",
    async () => {},
    ["attach", "video", "audioUnsupported", "failed"],
    {},
    media,
  );
  let resets = 0;
  s.video.value = {
    removeAttribute() {},
    load() {
      resets++;
    },
  };
  s.attach();
  const old = media.players[0];
  old.emit("demux", "unsupported", {
    msg: "Flv: Unsupported audio codec idx: 7",
  });
  old.emit("demux", "unsupported", {
    msg: "Flv: Unsupported audio codec idx: 7",
  });
  await Promise.resolve();
  assert.equal(old.destroyed, false, "不能在解码器尚未退出时销毁其事件发送器");
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(media.players.length, 2);
  assert.equal(media.players[1].source.hasAudio, false);
  assert.equal(resets, 1, "重建前清除HTMLMediaElement的旧错误状态");
  assert.equal(s.audioUnsupported.value, true);
  assert.equal(s.failed.value, false);
});

test("播放器错误迟到：关闭窗口后不能由排队的错误重建播放器", async (t) => {
  const media = mediaFixture();
  const { state: s, hooks } = component(
    t,
    "LivePlayer.vue",
    async () => {},
    ["attach"],
    {},
    media,
  );
  s.attach();
  media.players[0].emit(
    "demux",
    "unsupported",
    "Unsupported audio codec idx: 7",
  );
  hooks.unmounted.forEach((fn) => fn());
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(media.players.length, 1);
  assert.equal(media.players[0].destroyed, true);
});

test("播放器重连：旧点播迟到只释放自己的观看者，不覆盖新连接", async (t) => {
  const first = deferred(),
    second = deferred(),
    poll = deferred(),
    newPolling = deferred(),
    writes = [];
  let posts = 0;
  const { state: s, hooks } = component(
    t,
    "LivePlayer.vue",
    async (path, method) => {
      if (method === "POST") {
        posts++;
        return posts === 1 ? first.promise : second.promise;
      }
      if (method === "DELETE") {
        writes.push(path);
        return;
      }
      newPolling.resolve();
      return poll.promise;
    },
    ["connect", "get viewing(){return viewing}"],
    { channel: { id: "camera" } },
  );
  const old = s.connect();
  for (let i = 0; i < 10 && posts < 1; i++) await vue.nextTick();
  assert.equal(posts, 1);
  const current = s.connect();
  for (let i = 0; i < 10 && posts < 2; i++) await vue.nextTick();
  assert.equal(posts, 2);
  second.resolve({ sessionId: "new", viewerId: "new-viewer" });
  await newPolling.promise;
  assert.equal(s.viewing.sessionId, "new");
  first.resolve({ sessionId: "old", viewerId: "old-viewer" });
  await old;
  assert.equal(s.viewing.sessionId, "new");
  assert.deepEqual(writes, ["/live-sessions/old/viewers/old-viewer"]);
  hooks.unmounted.forEach((fn) => fn());
  poll.resolve({ state: "stopped" });
  await current;
});

test("播放器：失败后清除播放/就绪状态，已自然结束不被迟到错误覆盖", async (t) => {
  const { state: s } = component(t, "LivePlayer.vue", async () => {}, [
    "failure",
    "ready",
    "playing",
    "paused",
    "failed",
    "ended",
    "message",
  ]);
  s.ready.value = true;
  s.playing.value = true;
  s.paused.value = true;
  await s.failure(Error("连接失败"));
  assert.equal(s.failed.value, true);
  assert.equal(s.ready.value, false);
  assert.equal(s.playing.value, false);
  assert.equal(s.paused.value, false);
  s.ended.value = true;
  s.failed.value = false;
  s.message.value = "录像回放已结束";
  await s.failure(Error("迟到错误"));
  assert.equal(s.message.value, "录像回放已结束");
  assert.equal(s.failed.value, false);
});

test("平台重启恢复：保留子码流及声音设置，迟到点播仍回收自己的观看者", async (t) => {
  const posted = deferred(),
    response = deferred(),
    writes = [];
  const { state: s, hooks } = component(
    t,
    "LivePlayer.vue",
    async (path, method, value) => {
      if (method === "POST") {
        posted.resolve(value);
        return response.promise;
      }
      if (method === "DELETE") writes.push(path);
    },
    [
      "failure",
      "streamNumber",
      "muted",
      "volume",
      "prepare(){platformInstance='old';viewing={sessionId:'old',viewerId:'old-viewer'};}",
    ],
    { channel: { id: "camera" } },
    {
      probePlatform: async () => ({ instanceId: "new" }),
      waitForPlatformRestart: async () => "new",
    },
  );
  s.prepare();
  s.streamNumber.value = 1;
  s.muted.value = false;
  s.volume.value = 43;
  const failing = s.failure(Error("stream closed"));
  assert.deepEqual(await posted.promise, {
    channelId: "camera",
    streamNumber: 1,
  });
  assert.equal(s.muted.value, false);
  assert.equal(s.volume.value, 43);
  hooks.unmounted.forEach((fn) => fn());
  response.resolve({ sessionId: "new", viewerId: "new-viewer" });
  await failing;
  assert.deepEqual(writes, [
    "/live-sessions/old/viewers/old-viewer",
    "/live-sessions/new/viewers/new-viewer",
  ]);
});

test("平台重启恢复：重复错误只等待一次，窗口关闭后迟到恢复不再点播", async (t) => {
  const pending = deferred(),
    started = deferred();
  let signal,
    checks = 0,
    posts = 0;
  const { state: s, hooks } = component(
    t,
    "LivePlayer.vue",
    async (_path, method) => {
      if (method === "POST") posts++;
    },
    ["failure", "prepare(){platformInstance='old';}"],
    { channel: { id: "camera" } },
    {
      waitForPlatformRestart: (_id, options) => {
        signal = options.signal;
        checks++;
        started.resolve();
        return pending.promise;
      },
    },
  );
  s.prepare();
  const first = s.failure(Error("closed"));
  await started.promise;
  await s.failure(Error("duplicate"));
  assert.equal(checks, 1);
  hooks.unmounted.forEach((fn) => fn());
  assert.equal(signal.aborted, true);
  pending.resolve("new");
  await first;
  assert.equal(posts, 0);
});

test("平台重启恢复：权限失效和录像回放不会自动重新点播", async (t) => {
  for (const record of [
    undefined,
    { id: "clip", start: "2026-01-01T00:00:00Z", end: "2026-01-01T00:00:10Z" },
  ]) {
    let checks = 0;
    const { state: s } = component(
      t,
      "LivePlayer.vue",
      async () => {},
      ["failure", "failed", "prepare(){platformInstance='old';}"],
      { channel: { id: "camera" }, record },
      {
        waitForPlatformRestart: async () => {
          checks++;
          return "new";
        },
      },
    );
    s.prepare();
    await s.failure(record ? Error("closed") : new ApiError("forbidden", 403));
    assert.equal(checks, 0);
    assert.equal(s.failed.value, true);
  }
});

test("实时缩略图：只采集真实就绪帧，保留比例并限制15秒频率，失败不打断播放", (t) => {
  let draws = 0;
  let block = false;
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => ({
      drawImage() {
        draws++;
      },
      getImageData() {
        if (block) throw Error("Canvas blocked");
        return {
          width: 192,
          height: 108,
          data: new Uint8ClampedArray(192 * 108 * 4),
        };
      },
    }),
  };
  const { state: s, events } = component(t, "LivePlayer.vue", async () => {}, [
    "video",
    "playing",
    "captureThumbnail",
    "lastThumbnailAt",
  ]);
  s.video.value = {
    readyState: 1,
    videoWidth: 1920,
    videoHeight: 1080,
    ownerDocument: { createElement: () => canvas },
  };
  s.playing.value = true;
  s.captureThumbnail();
  assert.equal(events.length, 0);
  s.video.value.readyState = 4;
  s.captureThumbnail();
  assert.equal(draws, 1);
  assert.equal(canvas.width, 192);
  assert.equal(canvas.height, 108);
  assert.equal(events[0][0], "thumbnail");
  assert.equal(events[0][1].pixels.width, 192);
  s.captureThumbnail();
  assert.equal(draws, 1);
  s.lastThumbnailAt = 0;
  block = true;
  assert.doesNotThrow(() => s.captureThumbnail());
  assert.equal(s.playing.value, true);
  const { state: record, events: recordEvents } = component(
    t,
    "LivePlayer.vue",
    async () => {},
    ["video", "playing", "captureThumbnail"],
    { record: { start: "2026-11-07T00:00:00Z", end: "2026-11-07T01:00:00Z" } },
  );
  record.video.value = s.video.value;
  record.playing.value = true;
  record.captureThumbnail();
  assert.equal(recordEvents.length, 0);
});

test("通道缩略图限定当前预览、内存缓存64张，离开页面即清理", (t) => {
  const { state: s, hooks } = component(
    t,
    "Monitoring.vue",
    async () => ({ items: [], total: 0 }),
    ["slots", "thumbnails", "rememberThumbnail"],
  );
  const frame = {
    pixels: {
      width: 192,
      height: 108,
      data: new Uint8ClampedArray(192 * 108 * 4),
    },
    capturedAt: 1,
  };
  s.rememberThumbnail("unopened", frame);
  assert.equal(Object.keys(s.thumbnails.value).length, 0);
  for (let i = 0; i < 70; i++) {
    s.slots.value = [{ id: String(i) }];
    s.rememberThumbnail(String(i), { ...frame, capturedAt: i });
  }
  assert.equal(Object.keys(s.thumbnails.value).length, 64);
  assert.equal(s.thumbnails.value["0"], undefined);
  assert.ok(s.thumbnails.value["69"]);
  s.rememberThumbnail("69", {
    pixels: { width: 999, height: 108, data: new Uint8ClampedArray(0) },
    capturedAt: 99,
  });
  assert.equal(s.thumbnails.value["69"].capturedAt, 69);
  hooks.unmounted.forEach((fn) => fn());
  assert.deepEqual(s.thumbnails.value, {});
});

test("缩略图恢复只接受已授权当前列表，迟到缓存不能覆盖新检索和新画面", async (t) => {
  const pending = deferred();
  let reads = 0;
  const frame = {
    pixels: {
      width: 1,
      height: 1,
      data: new Uint8ClampedArray([1, 2, 3, 255]),
    },
    capturedAt: 10,
  };
  const { state: s } = component(
    t,
    "Monitoring.vue",
    async () => ({ items: [{ id: "allowed" }], total: 1 }),
    ["load", "thumbnails", "generation", "restoreThumbnails"],
    {},
    {
      thumbnailCache: {
        readThumbnails: () =>
          ++reads === 1
            ? pending.promise
            : Promise.resolve({
                allowed: { ...frame, capturedAt: 30 },
                forbidden: frame,
              }),
      },
    },
  );
  await s.load();
  await s.load();
  await Promise.resolve();
  assert.equal(s.thumbnails.value.allowed.capturedAt, 30);
  assert.equal(s.thumbnails.value.forbidden, undefined);
  pending.resolve({ allowed: { ...frame, capturedAt: 40 } });
  await Promise.resolve();
  assert.equal(s.thumbnails.value.allowed.capturedAt, 30);
});

test("预览元数据：未就绪保留空分辨率，码流尺寸变化更新真实信息", (t) => {
  const { state: s, events } = component(t, "LivePlayer.vue", async () => {}, [
    "video",
    "updateVideoInfo",
    "resolution",
  ]);
  s.video.value = { videoWidth: 0, videoHeight: 0 };
  s.updateVideoInfo();
  assert.equal(events.length, 0);
  for (const [width, height] of [
    [1920, 1080],
    [640, 480],
  ]) {
    s.video.value = { videoWidth: width, videoHeight: height };
    s.updateVideoInfo();
    assert.equal(s.resolution.value, `${width} × ${height}`);
  }
});

test("批量预览跨页检索在线授权结果，保留原窗口且不重复添加", async (t) => {
  const channel = (id, status = "online", deviceStatus = "online") => ({
    id,
    status,
    deviceStatus,
  });
  const first = channel("existing");
  const paths = [];
  const { state: s } = component(
    t,
    "Monitoring.vue",
    async (path) => {
      paths.push(path);
      return path.includes("page=2")
        ? { items: [channel("nvr-103")], total: 103 }
        : {
            items: [
              first,
              channel("offline", "offline"),
              channel("device-offline", "online", "offline"),
              ...Array.from({ length: 7 }, (_, i) => channel("new-" + i)),
            ],
            total: 103,
          };
    },
    ["openAll", "slots", "layout", "query", "batchNotice", "openingAll"],
  );
  s.slots.value[2] = first;
  s.layout.value = 9;
  s.query.value = "录像机 & 通道";
  await vue.nextTick();
  await s.openAll();
  assert.equal(paths.length, 2);
  assert.ok(
    paths.every((path) => path.includes(encodeURIComponent(s.query.value))),
  );
  assert.equal(s.layout.value, 9);
  assert.equal(s.slots.value[2].id, "existing");
  assert.equal(new Set(s.slots.value.filter(Boolean).map((c) => c.id)).size, 9);
  assert.equal(s.openingAll.value, false);
});

test("128路录像机跨过100条分页及离线通道后填满36格，刷新失败不产生额外槽位", async (t) => {
  const all = Array.from({ length: 128 }, (_, i) => ({
    id: "nvr-" + (i + 1),
    status: i < 64 ? "offline" : "online",
    deviceStatus: "online",
  }));
  const paths = [];
  const { state: s } = component(
    t,
    "Monitoring.vue",
    async (path) => {
      paths.push(path);
      const page = Number(
        new URL("http://test" + path).searchParams.get("page"),
      );
      return { items: all.slice((page - 1) * 100, page * 100), total: 128 };
    },
    ["openAll", "slots", "layout", "batchNotice"],
  );
  s.layout.value = 36;
  await s.openAll();
  assert.equal(paths.length, 2);
  assert.equal(s.layout.value, 36);
  assert.deepEqual(
    s.slots.value.map((c) => c.id),
    all.slice(64, 100).map((c) => c.id),
  );
  assert.equal(Object.keys(s.slots.value).includes("-1"), false);
  assert.match(s.batchNotice.value, /每页 36 画面/);
});

test("全部打开保留六档布局，64路按所选格数分页，九画面末页仅一路", async t => {
  const all = Array.from({length:64},(_,i)=>({id:String(i),name:`通道${i}`,status:'online',deviceStatus:'online'}));
  for(const layout of [1,4,9,16,25,36]) {
    const {state:s}=component(t,'Monitoring.vue',async path=>{
      const id=new URL('http://test'+path).searchParams.get('channelId');
      return {items:id===null?all:all.filter(c=>c.id===id),total:64};
    },['layout','openAll','slots','wallQueue','wallPageCount','changeWallPage','closeAll']);
    s.layout.value=layout;
    await s.openAll();
    assert.equal(s.layout.value,layout); assert.equal(s.slots.value.length,layout);
    assert.equal(s.wallQueue.value.length,64); assert.equal(s.wallPageCount.value,Math.ceil(64/layout));
    await s.changeWallPage(s.wallPageCount.value);
    assert.equal(s.slots.value.filter(Boolean).length,64%layout||layout);
    assert.equal(s.layout.value,layout); s.closeAll();
  }
});

test("缩小分屏保留后排选中通道，关闭放大格或刷新离线通道会还原", async (t) => {
  const { state: s } = component(
    t,
    "Monitoring.vue",
    async () => ({
      items: [{ id: "last", status: "offline", deviceStatus: "online" }],
      total: 1,
    }),
    [
      "slots",
      "active",
      "layout",
      "maximized",
      "toggleMaximize",
      "closeSlot",
      "changeLayout",
      "batchNotice",
      "load",
    ],
  );
  s.changeLayout(36);
  s.slots.value[35] = { id: "last" };
  s.active.value = 35;
  s.batchNotice.value = "已安排36路";
  s.changeLayout(9);
  assert.equal(s.slots.value[0].id, "last");
  assert.equal(s.active.value, 0);
  assert.equal(s.batchNotice.value, "");
  s.toggleMaximize(0);
  s.closeSlot(0);
  assert.equal(s.maximized.value, null);
  s.slots.value[0] = { id: "last" };
  s.toggleMaximize(0);
  await s.load();
  assert.equal(s.maximized.value, null);
  assert.equal(s.slots.value[0], null);
});

test("关闭全部不被入口通道的迟到加载重新打开，分屏及放大操作取消批量打开", async (t) => {
  const initial = deferred();
  const online = { id: "initial", status: "online", deviceStatus: "online" };
  const { state: s } = component(
    t,
    "Monitoring.vue",
    () => initial.promise,
    ["load", "closeAll", "slots"],
    { initialChannel: "initial" },
  );
  const loading = s.load();
  s.closeAll();
  initial.resolve({ items: [online], total: 1 });
  await loading;
  assert.ok(s.slots.value.every((c) => !c));
  for (const action of ["changeLayout", "toggleMaximize"]) {
    const late = deferred();
    const { state: other } = component(
      t,
      "Monitoring.vue",
      () => late.promise,
      ["openAll", "slots", "layout", "maximized", action],
    );
    const opening = other.openAll();
    other[action](action === "changeLayout" ? 9 : 0);
    late.resolve({ items: [online], total: 1 });
    await opening;
    assert.ok(other.slots.value.every((c) => !c));
    assert.equal(
      action === "changeLayout" ? other.layout.value : other.maximized.value,
      action === "changeLayout" ? 9 : 0,
    );
  }
});

test("批量预览保持所选36画面，超出分页且检索失败保留原预览", async (t) => {
  let fail = false;
  const { state: s } = component(
    t,
    "Monitoring.vue",
    async () => {
      if (fail) throw Error("网络中断");
      return {
        items: Array.from({ length: 50 }, (_, i) => ({
          id: String(i),
          status: "online",
          deviceStatus: "online",
        })),
        total: 50,
      };
    },
    ["openAll", "slots", "layout", "batchNotice"],
  );
  s.layout.value = 36;
  await s.openAll();
  assert.equal(s.layout.value, 36);
  assert.equal(s.slots.value.filter(Boolean).length, 36);
  assert.match(s.batchNotice.value, /每页 36 画面/);
  const saved = s.slots.value.slice();
  fail = true;
  await s.openAll();
  assert.deepEqual(s.slots.value, saved);
  assert.match(s.batchNotice.value, /批量打开失败/);
});

test("关闭全部及手动选通道取消迟到批量结果，空结果不误报播放成功", async (t) => {
  const pending = deferred();
  const { state: s } = component(t, "Monitoring.vue", () => pending.promise, [
    "openAll",
    "closeAll",
    "slots",
    "openingAll",
    "batchNotice",
    "maximized",
    "choose",
  ]);
  s.slots.value[0] = { id: "old" };
  s.maximized.value = 0;
  const opening = s.openAll();
  s.closeAll();
  pending.resolve({
    items: [{ id: "late", status: "online", deviceStatus: "online" }],
    total: 1,
  });
  await opening;
  assert.ok(s.slots.value.every((c) => c === null));
  assert.equal(s.maximized.value, null);
  assert.equal(s.openingAll.value, false);
  assert.equal(s.batchNotice.value, "已关闭全部预览");
  const delayed = deferred();
  const { state: other } = component(
    t,
    "Monitoring.vue",
    () => delayed.promise,
    ["openAll", "slots", "choose"],
  );
  const result = other.openAll();
  other.choose({ id: "manual", status: "online", deviceStatus: "online" });
  delayed.resolve({
    items: [{ id: "late", status: "online", deviceStatus: "online" }],
    total: 1,
  });
  await result;
  assert.equal(other.slots.value[0].id, "manual");
  const { state: empty } = component(
    t,
    "Monitoring.vue",
    async () => ({ items: [], total: 0 }),
    ["openAll", "batchNotice", "slots"],
  );
  await empty.openAll();
  assert.match(empty.batchNotice.value, /没有可预览的在线通道/);
  assert.ok(empty.slots.value.every((c) => !c));
});

test("预览布局：六档槽位随布局伸缩，取消8画面且不保留不可见观看", (t) => {
  const { state: s } = component(
    t,
    "Monitoring.vue",
    async () => ({ items: [] }),
    ["layout", "slots", "active", "changeLayout", "choose"],
  );
  for (const count of [1, 4, 9, 16, 25, 36]) {
    s.changeLayout(count);
    assert.equal(s.layout.value, count);
    assert.equal(s.slots.value.length, count);
    s.active.value = count - 1;
    s.choose({ id: "c" + count, status: "online", deviceStatus: "online" });
    assert.equal(s.slots.value[count - 1].id, "c" + count);
  }
  s.changeLayout(4);
  assert.equal(s.slots.value.length, 4);
  assert.ok(s.active.value < 4);
  const before = s.slots.value.slice();
  s.changeLayout(7);
  s.changeLayout(8);
  assert.equal(s.layout.value, 4);
  assert.deepEqual(s.slots.value, before);
});

test("预览通道分页：跨页保留正在播放的通道，搜索查询服务端全部结果", async (t) => {
  const a = { id: "a", status: "online", deviceStatus: "online" };
  const b = { id: "b", status: "online", deviceStatus: "online" };
  const paths = [];
  const { state: s } = component(
    t,
    "Monitoring.vue",
    async (path) => {
      paths.push(path);
      return { items: path.includes("page=2") ? [b] : [a], total: 33 };
    },
    ["load", "page", "pageCount", "slots", "choose", "query"],
  );
  await s.load();
  s.choose(a);
  await s.load(2);
  assert.equal(s.page.value, 2);
  assert.equal(s.pageCount.value, 2);
  assert.equal(s.slots.value[0].id, "a");
  s.query.value = "录像机 & 通道33";
  await vue.nextTick();
  await s.load(1);
  assert.match(paths.at(-1), /page=1&pageSize=32&q=/);
  assert.ok(paths.at(-1).includes(encodeURIComponent(s.query.value)));
});

test("预览通道分页：迟到响应不覆盖新页，翻页失败可重试且不清除播放", async (t) => {
  const old = deferred();
  let fail = false;
  const { state: s } = component(
    t,
    "Monitoring.vue",
    async (path) => {
      if (path.includes("page=1")) return old.promise;
      if (fail) throw Error("分页读取失败");
      return { items: [{ id: "page-two" }], total: 33 };
    },
    ["load", "page", "channels", "message", "loading", "slots"],
  );
  s.slots.value[0] = { id: "playing" };
  const pending = s.load(1);
  await s.load(2);
  old.resolve({ items: [{ id: "old" }], total: 33 });
  await pending;
  assert.equal(s.channels.value[0].id, "page-two");
  fail = true;
  await s.load(2);
  assert.equal(s.loading.value, false);
  assert.equal(s.channels.value.length, 0);
  assert.equal(s.slots.value[0].id, "playing");
  assert.match(s.message.value, /分页读取失败/);
  fail = false;
  await s.load(2);
  assert.equal(s.channels.value[0].id, "page-two");
});

test("预览入口：初始通道不在第一页也能按权限读取并打开", async (t) => {
  const target = {
    id: "nvr:channel-1030",
    status: "online",
    deviceStatus: "online",
  };
  const { state: s } = component(
    t,
    "Monitoring.vue",
    async (path) => ({
      items: path.includes("channelId=") ? [target] : [],
      total: 1030,
    }),
    ["load", "slots"],
    { initialChannel: target.id },
  );
  await s.load();
  assert.equal(s.slots.value[0].id, target.id);
});

test("设备通道分页：第33路可达、失败可重试，关闭后忽略迟到翻页", async (t) => {
  const late = deferred();
  let fail = false,
    delayed = false;
  const { state: s } = component(
    t,
    "Devices.vue",
    async (path) => {
      if (path.includes("page=2")) {
        if (delayed) return late.promise;
        if (fail) throw Error("网络失败");
        return { items: [{ id: "channel-33" }], total: 33 };
      }
      return {
        items: Array.from({ length: 32 }, (_, i) => ({
          id: "channel-" + (i + 1),
        })),
        total: 33,
      };
    },
    [
      "showChannels",
      "loadChannels",
      "channelsDialog",
      "channels",
      "channelPage",
      "channelPageCount",
      "channelLoading",
      "closeChannels",
    ],
  );
  s.channelsDialog.value = dialog();
  await s.showChannels(device("nvr"));
  assert.equal(s.channels.value.length, 32);
  assert.equal(s.channelPageCount.value, 2);
  fail = true;
  await s.loadChannels(2);
  assert.equal(s.channelPage.value, 1);
  assert.equal(s.channelLoading.value, false);
  fail = false;
  await s.loadChannels(2);
  assert.equal(s.channelPage.value, 2);
  assert.equal(s.channels.value[0].id, "channel-33");
  delayed = true;
  const pending = s.loadChannels(2);
  s.channelsDialog.value.close();
  s.closeChannels();
  late.resolve({ items: [{ id: "late" }], total: 33 });
  await pending;
  assert.equal(s.channels.value.length, 0);
});

test("预览布局：单画面保留当前选中通道，刷新只关闭失效通道", async (t) => {
  const a = {
      id: "a",
      name: "录像机通道1",
      status: "online",
      deviceStatus: "online",
    },
    b = {
      id: "b",
      name: "录像机通道2",
      status: "online",
      deviceStatus: "online",
    };
  const { state: s } = component(
    t,
    "Monitoring.vue",
    async () => ({ items: [a, { ...b, status: "offline" }], total: 2 }),
    ["layout", "slots", "active", "changeLayout", "choose", "load"],
  );
  s.active.value = 0;
  s.choose(a);
  s.active.value = 3;
  s.choose(b);
  s.changeLayout(1);
  assert.equal(s.slots.value[0].id, "b");
  s.changeLayout(4);
  s.active.value = 1;
  s.choose(a);
  await s.load();
  assert.equal(s.slots.value[0], null);
  assert.equal(s.slots.value[1].id, "a");
});

test("录像检索：更改条件后清空旧录像和回放，并允许重新检索", async (t) => {
  const response = deferred();
  let posts = 0;
  const { state: s } = component(
    t,
    "Records.vue",
    async (path) => {
      if (path === "/record-queries") {
        posts++;
        return response.promise;
      }
      return { status: "succeeded", items: [{ id: "old" }] };
    },
    ["channelId", "start", "end", "search", "items", "selected", "busy"],
  );
  s.channelId.value = "channel";
  s.start.value = "2026-11-02T08:00";
  s.end.value = "2026-11-02T09:00";
  await vue.nextTick();
  s.items.value = [{ id: "previous" }];
  s.selected.value = s.items.value[0];
  const pending = s.search();
  s.start.value = "2026-11-02T08:30";
  await vue.nextTick();
  assert.equal(s.busy.value, false);
  assert.equal(s.items.value.length, 0);
  assert.equal(s.selected.value, null);
  response.resolve({ taskId: "old-task" });
  await pending;
  assert.equal(s.items.value.length, 0);
  assert.equal(posts, 1);
});

test("录像导出：离开页面后返回成功不得触发页面跳转", async (t) => {
  const response = deferred(),
    {
      state: s,
      hooks,
      events,
    } = component(t, "Records.vue", () => response.promise, ["download"]);
  const pending = s.download({ id: "clip" });
  hooks.unmounted.forEach((fn) => fn());
  response.resolve({ id: "job" });
  await pending;
  assert.equal(events.length, 0);
});

test("录像检索：已完成结果随条件失效，非法时间范围不发送任务", async (t) => {
  let posts = 0;
  const { state: s } = component(
    t,
    "Records.vue",
    async (path) => {
      if (path === "/record-queries") {
        posts++;
        return { taskId: "task" };
      }
      return { status: "succeeded", items: [{ id: "clip" }] };
    },
    ["channelId", "start", "end", "search", "items", "selected", "message"],
  );
  s.channelId.value = "channel";
  s.start.value = "2026-11-02T08:00";
  s.end.value = "2026-11-02T09:00";
  await vue.nextTick();
  await s.search();
  assert.equal(s.items.value.length, 1);
  s.selected.value = s.items.value[0];
  s.end.value = "2026-11-02T10:00";
  await vue.nextTick();
  assert.equal(s.items.value.length, 0);
  assert.equal(s.selected.value, null);
  for (const [a, b] of [
    ["2026-11-02T10:00", "2026-11-02T10:00"],
    ["2026-11-02T11:00", "2026-11-02T10:00"],
    ["2026-11-01T08:00", "2026-11-02T10:00"],
    ["invalid", "2026-11-02T10:00"],
  ]) {
    s.start.value = a;
    s.end.value = b;
    await vue.nextTick();
    await s.search();
    assert.match(s.message.value, /24小时/);
    assert.equal(posts, 1);
  }
});

async function trajectory(t, api) {
  const c = component(
    t,
    "Trajectories.vue",
    (path) =>
      path.endsWith("/position-targets")
        ? Promise.resolve({ items: [{ code: "target", name: "目标" }] })
        : api(path),
    [
      "query",
      "points",
      "cursor",
      "total",
      "deviceId",
      "targetCode",
      "start",
      "end",
      "busy",
      "message",
    ],
  );
  c.state.deviceId.value = "device";
  await vue.nextTick();
  await vue.nextTick();
  return c.state;
}
const positions = (id, nextCursor = null) => ({
  items: [
    {
      id,
      targetCode: "target",
      longitude: 116.4,
      latitude: 39.9,
      occurredAt: "2026-11-02T00:10:00Z",
      receivedAt: "2026-11-02T00:10:00Z",
    },
  ],
  total: 2,
  nextCursor,
  retentionDays: 30,
});

test("历史轨迹：切换条件后可立即重查，旧响应不能解除新请求的忙碌状态", async (t) => {
  const first = deferred(),
    second = deferred();
  let calls = 0;
  const s = await trajectory(t, () =>
    ++calls === 1 ? first.promise : second.promise,
  );
  const a = s.query();
  s.start.value = "2026-11-02T00:00";
  s.end.value = "2026-11-02T01:00";
  await vue.nextTick();
  assert.equal(s.busy.value, false);
  const b = s.query();
  first.resolve(positions("old"));
  await a;
  assert.equal(s.busy.value, true);
  assert.equal(s.points.value.length, 0);
  second.resolve(positions("new"));
  await b;
  assert.equal(s.points.value[0].id, "new");
  assert.equal(s.busy.value, false);
});

test("历史轨迹：加载更多遇到临时故障保留已加载点和游标，可原页重试", async (t) => {
  for (const error of [
    Error("网络连接失败"),
    new ApiError("服务繁忙", 503),
    new ApiError("请求频繁", 429),
  ]) {
    let calls = 0;
    const paths = [];
    const s = await trajectory(t, async (path) => {
      paths.push(path);
      if (++calls === 1) return positions("first", "cursor-one");
      if (calls === 2) throw error;
      return positions("second");
    });
    await s.query();
    await s.query(true);
    assert.equal(s.points.value.length, 1);
    assert.equal(s.cursor.value, "cursor-one");
    assert.equal(s.busy.value, false);
    await s.query(true);
    assert.deepEqual(
      s.points.value.map((p) => p.id),
      ["first", "second"],
    );
    assert.ok(paths[2].includes("cursor=cursor-one"));
  }
});

test("历史轨迹：权限、资源不存在或失效游标错误必须清除旧点位", async (t) => {
  for (const status of [401, 403, 404, 400]) {
    let calls = 0;
    const s = await trajectory(t, async () => {
      if (++calls === 1) return positions("first", "cursor-one");
      throw new ApiError("访问失败", status);
    });
    await s.query();
    await s.query(true);
    assert.equal(s.points.value.length, 0);
    assert.equal(s.cursor.value, null);
    assert.equal(s.busy.value, false);
  }
});

test("设备通道：前一个设备的迟到成功或失败不能覆盖当前设备", async (t) => {
  for (const failOld of [false, true]) {
    const first = deferred(),
      second = deferred();
    const { state: s } = component(
      t,
      "Devices.vue",
      (path) => (path.includes("/first/") ? first.promise : second.promise),
      ["showChannels", "channels", "channelsDialog", "channelMessage"],
    );
    s.channelsDialog.value = dialog();
    const a = s.showChannels(device("first")),
      b = s.showChannels(device("second"));
    second.resolve({ items: [{ id: "current", name: "当前通道" }], total: 1 });
    await b;
    if (failOld) first.reject(Error("旧设备读取失败"));
    else first.resolve({ items: [] });
    await a;
    assert.equal(s.channels.value[0]?.id, "current");
    assert.doesNotMatch(s.channelMessage.value, /旧设备|暂无通道/);
  }
});

test("设备通道：离开页面后迟到响应不再写入界面状态", async (t) => {
  const response = deferred(),
    { state: s, hooks } = component(t, "Devices.vue", () => response.promise, [
      "showChannels",
      "channels",
      "channelsDialog",
    ]);
  s.channelsDialog.value = dialog();
  const pending = s.showChannels(device("first"));
  hooks.unmounted.forEach((fn) => fn());
  response.resolve({ items: [{ id: "late" }] });
  await pending;
  assert.equal(s.channels.value.length, 0);
});

test("分组移入：读取失败清空旧搜索结果，禁止提交旧选择", async (t) => {
  let fail = false,
    writes = 0;
  const { state: s } = component(
    t,
    "Groups.vue",
    async (path, method) => {
      if (method === "PUT") {
        writes++;
        return;
      }
      if (path.startsWith("/devices")) {
        if (fail) throw Error("设备读取失败");
        return { items: [device("old")], total: 1 };
      }
      return { items: [] };
    },
    [
      "assign",
      "loadDevices",
      "move",
      "devices",
      "deviceTotal",
      "query",
      "selectedIds",
      "assignment",
    ],
  );
  s.assignment.value = dialog();
  await s.assign({ id: "group", name: "测试分组" });
  s.selectedIds.value = ["old"];
  s.query.value = "另一个设备";
  fail = true;
  await s.loadDevices();
  assert.equal(s.devices.value.length, 0);
  assert.equal(s.deviceTotal.value, 0);
  await s.move();
  assert.equal(writes, 0);
});

test("分组移入：列表仍在读取时不能提交，成功恢复后允许移入", async (t) => {
  let response = null,
    writes = 0;
  const { state: s } = component(
    t,
    "Groups.vue",
    async (path, method) => {
      if (method === "PUT") {
        writes++;
        return;
      }
      if (path.startsWith("/devices"))
        return response
          ? response.promise
          : { items: [device("chosen")], total: 1 };
      return { items: [] };
    },
    ["assign", "loadDevices", "move", "selectedIds", "assignment"],
  );
  s.assignment.value = dialog();
  await s.assign({ id: "group", name: "测试分组" });
  s.selectedIds.value = ["chosen"];
  response = deferred();
  const loading = s.loadDevices();
  await s.move();
  assert.equal(writes, 0);
  response.resolve({ items: [device("chosen")], total: 1 });
  await loading;
  await s.move();
  assert.equal(writes, 1);
});

test("只读通道弹窗关闭后忽略迟到响应，重新打开可正常读取", async (t) => {
  const response = deferred();
  let first = true;
  const { state: s } = component(
    t,
    "Devices.vue",
    () =>
      first
        ? response.promise
        : Promise.resolve({ items: [{ id: "new" }], total: 1 }),
    ["showChannels", "closeChannels", "channels", "channelsDialog"],
  );
  s.channelsDialog.value = dialog();
  const pending = s.showChannels(device("first"));
  s.channelsDialog.value.close();
  s.closeChannels();
  response.resolve({ items: [{ id: "late" }] });
  await pending;
  assert.equal(s.channels.value.length, 0);
  first = false;
  await s.showChannels(device("second"));
  assert.equal(s.channels.value[0].id, "new");
});

test("分组弹窗关闭后迟到结果不重新打开弹窗、不回填设备", async (t) => {
  const response = deferred(),
    { state: s } = component(t, "Groups.vue", () => response.promise, [
      "assign",
      "closeAssignment",
      "devices",
      "assignment",
    ]);
  s.assignment.value = dialog();
  const pending = s.assign({ id: "group", name: "测试分组" });
  assert.equal(s.assignment.value.open, true);
  s.assignment.value.close();
  s.closeAssignment();
  response.resolve({ items: [device("late")], total: 1 });
  await pending;
  assert.equal(s.assignment.value.open, false);
  assert.equal(s.devices.value.length, 0);
});

test("分组授权未就绪不可保存，冲突保留选择并要求重新读取", async (t) => {
  let writes = 0;
  const { state: s } = component(
    t,
    "Groups.vue",
    async (_path, method) => {
      if (method) {
        writes++;
        throw new ApiError("授权已更新", 409, "AUTHORIZATION_CONFLICT");
      }
      return { groupIds: ["new"], version: 2, scopeMode: "groups" };
    },
    [
      "saveGrants",
      "readGrants",
      "userId",
      "grantIds",
      "grantReady",
      "grantVersion",
      "message",
    ],
  );
  await s.saveGrants();
  assert.equal(writes, 0);
  s.userId.value = "reader";
  s.grantReady.value = true;
  s.grantIds.value = ["draft"];
  await s.saveGrants();
  assert.equal(writes, 1);
  assert.equal(s.grantReady.value, false);
  assert.deepEqual(s.grantIds.value, ["draft"]);
  await s.saveGrants();
  assert.equal(writes, 1);
  await s.readGrants();
  assert.equal(s.grantVersion.value, 2);
  assert.equal(s.grantReady.value, true);
  assert.deepEqual(s.grantIds.value, ["new"]);
});

function isolatedSessionStorage(t, initial = {}) {
  const previous = Object.getOwnPropertyDescriptor(
    globalThis,
    "sessionStorage",
  );
  const values = new Map(Object.entries(initial));
  Object.defineProperty(globalThis, "sessionStorage", {
    configurable: true,
    value: {
      getItem: (key) => values.get(key) || null,
      setItem: (key, value) => values.set(key, value),
      removeItem: (key) => values.delete(key),
    },
  });
  t.after(() =>
    previous
      ? Object.defineProperty(globalThis, "sessionStorage", previous)
      : delete globalThis.sessionStorage,
  );
  return values;
}
test("监控刷新精确恢复窗口与布局，删除或无权通道保留空位", async (t) => {
  isolatedSessionStorage(t, {
    "ls-aegis:monitoring-windows:admin": JSON.stringify({
      layout: 9,
      active: 7,
      channels: [null, "a", null, "deleted", null, null, null, "b"],
    }),
  });
  const { state: s } = component(
    t,
    "Monitoring.vue",
    async (path) => ({
      items: path.includes("deleted")
        ? []
        : [
            {
              id: path.includes("channelId=a") ? "a" : "b",
              status: "online",
              deviceStatus: "online",
            },
          ],
    }),
    ["restoreWindows", "slots", "layout", "active", "batchNotice"],
  );
  await s.restoreWindows();
  assert.equal(s.layout.value, 9);
  assert.equal(s.active.value, 7);
  assert.equal(s.slots.value[1].id, "a");
  assert.equal(s.slots.value[7].id, "b");
  assert.equal(s.slots.value[3], null);
  assert.match(s.batchNotice.value, /1 路通道暂不可用/);
});
test("恢复窗口的迟到响应不能覆盖全部关闭或手动选择", async (t) => {
  isolatedSessionStorage(t, {
    "ls-aegis:monitoring-windows:admin": JSON.stringify({
      layout: 36,
      active: 35,
      channels: ["old"],
    }),
  });
  const request = deferred();
  const { state: s } = component(t, "Monitoring.vue", () => request.promise, [
    "restoreWindows",
    "closeAll",
    "slots",
    "layout",
  ]);
  const restoring = s.restoreWindows();
  s.closeAll();
  request.resolve({
    items: [{ id: "old", status: "online", deviceStatus: "online" }],
  });
  await restoring;
  assert.equal(s.layout.value, 4);
  assert.ok(s.slots.value.every((slot) => slot === null));
});
test("刷新播放器复用仍有效的原观看者，避免36画面重复申请租约", async (t) => {
  isolatedSessionStorage(t, {
    "qa:viewer": JSON.stringify({
      sessionId: "session",
      viewerId: "viewer",
      channelId: "channel",
      streamNumber: 1,
    }),
  });
  const calls = [];
  const { state: s } = component(
    t,
    "LivePlayer.vue",
    async (path, method) => {
      calls.push([path, method]);
      return { state: "ready", playUrl: "/stream.flv" };
    },
    ["acquireViewer", "streamNumber"],
    { channel: { id: "channel" }, resumeKey: "qa" },
  );
  const result = await s.acquireViewer();
  assert.equal(result.viewerId, "viewer");
  assert.equal(s.streamNumber.value, 1);
  assert.equal(calls.length, 2);
  assert.ok(calls[1][0].endsWith("/renew"));
  assert.ok(!calls.some(([path]) => path === "/live-sessions"));
});
test("旧观看者已结束时释放旧租约再新建，保持原子码流", async (t) => {
  isolatedSessionStorage(t, {
    "qa:viewer": JSON.stringify({
      sessionId: "old",
      viewerId: "old",
      channelId: "channel",
      streamNumber: 1,
    }),
  });
  const calls = [];
  const { state: s } = component(
    t,
    "LivePlayer.vue",
    async (path, method, data) => {
      calls.push([path, method, data]);
      return path === "/live-sessions"
        ? { sessionId: "new", viewerId: "new", state: "waiting_media" }
        : { state: "stopped" };
    },
    ["acquireViewer"],
    { channel: { id: "channel" }, resumeKey: "qa" },
  );
  assert.equal((await s.acquireViewer()).viewerId, "new");
  assert.equal(calls[1][1], "DELETE");
  assert.equal(calls[2][2].streamNumber, 1);
});
test("多通道回放缩小布局关闭超出窗口，放大不改变剩余通道", async (t) => {
  const items = Array.from({ length: 9 }, (_, i) => ({
    id: String(i),
    name: String(i),
  }));
  const { state: s, events } = component(
    t,
    "PlaybackWall.vue",
    async () => {},
    ["changeLayout", "layout", "maximized"],
    { items },
  );
  s.maximized.value = 2;
  s.changeLayout(4);
  assert.equal(s.maximized.value, null);
  assert.equal(s.layout.value, 4);
  assert.deepEqual(
    events.map((event) => event[1]),
    ["4", "5", "6", "7", "8"],
  );
});

test("设备多通道回放切换检索保留其他窗口，同通道新录像只替换本通道", async (t) => {
  const { state: s } = component(t, "Records.vue", async () => ({}), [
    "openClip",
    "playbackClips",
    "channelId",
    "source",
  ]);
  s.openClip({ id: "a1", channelId: "a" });
  s.openClip({ id: "b1", channelId: "b" });
  s.channelId.value = "c";
  await vue.nextTick();
  assert.deepEqual(
    s.playbackClips.value.map((clip) => clip.id),
    ["a1", "b1"],
  );
  s.openClip({ id: "a2", channelId: "a" });
  assert.deepEqual(
    s.playbackClips.value.map((clip) => clip.id),
    ["a2", "b1"],
  );
  s.source.value = "device";
  await vue.nextTick();
  assert.equal(s.playbackClips.value.length, 0);
});
test("平台多通道回放按各自通道选文件，重复加入不重复创建播放器", async (t) => {
  const { state: s } = component(
    t,
    "RecordingCenter.vue",
    async () => ({}),
    [
      "jobs",
      "libraryChannel",
      "libraryDate",
      "addPlaybackChannel",
      "playbackChannels",
      "filesForDay",
    ],
    { section: "library" },
  );
  s.libraryDate.value = "2026-11-07";
  s.jobs.value = [
    {
      id: "a",
      kind: "scheduled",
      channelId: "a",
      channelName: "A",
      files: [{ id: "fa", name: "a.mp4", date: "2026-11-07" }],
    },
    {
      id: "b",
      kind: "scheduled",
      channelId: "b",
      channelName: "B",
      files: [{ id: "fb", name: "b.mp4", date: "2026-11-07" }],
    },
  ];
  s.libraryChannel.value = "a";
  s.addPlaybackChannel();
  s.addPlaybackChannel();
  s.libraryChannel.value = "b";
  s.addPlaybackChannel();
  assert.deepEqual([...s.playbackChannels.value], ["a", "b"]);
  assert.equal(s.filesForDay("a")[0].id, "fa");
  assert.equal(s.filesForDay("b")[0].id, "fb");
});
test("录像任务弹窗跟随当天聚合记录刷新，不保留过期文件快照", async (t) => {
  const { state: s } = component(
    t,
    "RecordingCenter.vue",
    async () => ({}),
    ["jobs", "showDetails", "detailDialog", "detailJob"],
    { section: "jobs" },
  );
  let opened = 0;
  s.detailDialog.value = {
    showModal() {
      opened++;
    },
  };
  const first = { id: "attempt1", dailyKey: "day", files: [] };
  s.jobs.value = [first];
  s.showDetails(first, "files");
  s.jobs.value = [{ id: "attempt2", dailyKey: "day", files: [{ id: "new" }] }];
  assert.equal(opened, 1);
  assert.equal(s.detailJob.value.files[0].id, "new");
  s.jobs.value = [];
  assert.equal(s.detailJob.value, undefined);
});

test("同步回放按首个窗口定位，合并覆盖且暂停后不推进", (t) => {
  const { state: s } = component(
    t,
    "PlaybackWall.vue",
    async () => {},
    ["clock", "coverage", "togglePlayback", "seek", "tick"],
    {
      items: [{ id: "a" }, { id: "b" }],
      ranges: {
        a: [{ start: 100, end: 200 }],
        b: [
          { start: 150, end: 300 },
          { start: 500, end: 600 },
        ],
      },
    },
  );
  assert.deepEqual(
    [...s.coverage.value],
    [
      { start: 100, end: 300 },
      { start: 500, end: 600 },
    ],
  );
  s.togglePlayback();
  assert.equal(s.clock.value.position, 100);
  assert.equal(s.clock.value.playing, true);
  s.togglePlayback();
  const position = s.clock.value.position;
  s.tick();
  assert.equal(s.clock.value.position, position);
  s.seek(400);
  assert.equal(s.clock.value.position, 400);
});
test("平台同步回放统一定位暂停与倍速，空档不跳到其他录像时刻", async (t) => {
  const clock = vue.reactive({
    position: 110,
    playing: false,
    speed: 2,
    muted: true,
    revision: 1,
  });
  const { state: s } = component(
    t,
    "ArchiveDayPlayer.vue",
    async () => {},
    ["video", "segments", "current", "syncArchive", "loaded"],
    { channelId: "a", channelName: "A", date: "2026-11-07", files: [], clock },
  );
  await Promise.resolve();
  const video = {
    paused: true,
    ended: false,
    readyState: 4,
    currentTime: 0,
    playbackRate: 1,
    load() {},
    removeAttribute() {},
    pause() {
      this.paused = true;
    },
    async play() {
      this.paused = false;
    },
  };
  s.video.value = video;
  s.segments.value = [
    { id: "a", start: 100, end: 120, url: "/a.mp4" },
    { id: "b", start: 200, end: 220, url: "/b.mp4" },
  ];
  s.syncArchive();
  s.loaded();
  assert.equal(video.currentTime, 10);
  assert.equal(video.paused, true);
  assert.equal(video.playbackRate, 2);
  clock.playing = true;
  s.syncArchive();
  await Promise.resolve();
  assert.equal(video.paused, false);
  clock.position = 150;
  clock.revision++;
  s.syncArchive();
  assert.equal(s.current.value, null);
  assert.equal(video.paused, true);
  clock.position = 205;
  clock.revision++;
  s.syncArchive();
  s.loaded();
  assert.equal(s.current.value.id, "b");
  assert.equal(video.currentTime, 5);
});
test("设备同步回放把北京时间转换为录像内偏移，统一倍速与暂停", async (t) => {
  const calls = [],
    media = mediaFixture();
  const clock = {
    position: 43210,
    playing: false,
    speed: 2,
    muted: true,
    revision: 1,
  };
  const { state: s } = component(
    t,
    "LivePlayer.vue",
    async (path, method, body) => {
      if (body?.action) calls.push(body);
      return {};
    },
    [
      "video",
      "synchronizeDevice",
      "prepare(){viewing={sessionId:'s',viewerId:'v'};ready.value=true;}",
    ],
    {
      channel: { id: "a" },
      record: {
        id: "r",
        start: "2026-11-07T04:00:00Z",
        end: "2026-11-07T04:10:00Z",
      },
      playbackDate: "2026-11-07",
      playbackClock: clock,
    },
    media,
  );
  s.video.value = {
    currentTime: 0,
    muted: true,
    volume: 1,
    removeAttribute() {},
    load() {},
  };
  s.prepare();
  await s.synchronizeDevice();
  assert.deepEqual(
    calls.map((call) => call.action),
    ["seek", "speed", "pause"],
  );
  assert.equal(calls[0].position, 10);
  assert.equal(calls[1].scale, 2);
});
test("直播瞬断仅在原会话就绪时重连，重试封顶后显示具体错误且回收自身租约", async (t) => {
  const calls = [];
  const { state: s } = component(
    t,
    "LivePlayer.vue",
    async (path, method) => {
      calls.push([path, method]);
      return { state: "ready" };
    },
    [
      "mediaFailure",
      "mediaDiagnostic",
      "failed",
      "prepare(count){viewing={sessionId:'s',viewerId:'v'};mediaRetries=count;}",
    ],
    { channel: { id: "a" } },
  );
  s.prepare(0);
  await s.mediaFailure("NetworkError", "Exception", "connection lost");
  assert.equal(s.failed.value, false);
  assert.ok(!calls.some(([, method]) => method === "DELETE"));
  s.prepare(2);
  await s.mediaFailure("NetworkError", "Exception", "connection lost");
  assert.equal(s.failed.value, true);
  assert.match(s.mediaDiagnostic.value, /媒体连接中断.*NetworkError/);
  assert.equal(calls.filter(([, method]) => method === "DELETE").length, 1);
});
test("设备回放正常结束不显示媒体失败", async (t) => {
  const { state: s } = component(
    t,
    "LivePlayer.vue",
    async () => ({ state: "completed" }),
    [
      "mediaFailure",
      "ended",
      "failed",
      "prepare(){viewing={sessionId:'s',viewerId:'v'};}",
    ],
    {
      channel: { id: "a" },
      record: { start: "2026-11-07T00:00:00Z", end: "2026-11-07T00:10:00Z" },
    },
  );
  s.prepare();
  await s.mediaFailure("NetworkError", "EOF", "");
  assert.equal(s.ended.value, true);
  assert.equal(s.failed.value, false);
});

test("媒体状态返回403时直接释放预览，不续租或重新点播", async (t) => {
  const calls = [];
  const { state: s } = component(
    t,
    "LivePlayer.vue",
    async (path, method) => {
      calls.push([path, method]);
      if (method !== "DELETE") throw new ApiError("没有设备权限", 403);
    },
    [
      "mediaFailure",
      "failed",
      "message",
      "prepare(){viewing={sessionId:'s',viewerId:'v'};}",
    ],
    { channel: { id: "a" } },
  );
  s.prepare();
  await s.mediaFailure("NetworkError", "EOF", "");
  assert.equal(s.failed.value, true);
  assert.match(s.message.value, /没有设备权限/);
  assert.equal(calls.length, 2);
  assert.equal(calls[1][1], "DELETE");
});

test("通道拖放到指定空位，同一通道可有多个独立窗口，关闭后不移动其他窗口", async (t) => {
  const { state: s } = component(
    t,
    "RecordingCenter.vue",
    async () => ({}),
    [
      "jobs",
      "libraryChannel",
      "libraryDate",
      "dropArchiveChannel",
      "appliedArchiveRange",
      "queriedArchiveChannels",
      "archiveStartInput",
      "archiveEndInput",
      "archiveWindows",
      "closeArchiveWindow",
    ],
    { section: "library" },
  );
  s.jobs.value = [
    {
      id: "job",
      channelId: "channel",
      channelName: "通道",
      kind: "scheduled",
      files: [{ id: "file", date: "2026-11-07", name: "12-00-00.mp4" }],
    },
  ];
  s.libraryDate.value = "2026-11-07";
  s.appliedArchiveRange.value = recordRange.recordSearchRange(
    s.archiveStartInput.value,
    s.archiveEndInput.value,
  );
  s.queriedArchiveChannels.add("channel");
  await s.dropArchiveChannel({ channelId: "channel", slot: 0 });
  await s.dropArchiveChannel({ channelId: "channel", slot: 3 });
  assert.equal(s.archiveWindows.value.length, 2);
  assert.notEqual(s.archiveWindows.value[0].id, s.archiveWindows.value[1].id);
  const second = s.archiveWindows.value[1].id;
  s.closeArchiveWindow(s.archiveWindows.value[0].id);
  assert.equal(s.archiveWindows.value[0].id, second);
  assert.equal(s.archiveWindows.value[0].slot, 3);
  await s.dropArchiveChannel({ channelId: "unknown", slot: 1 });
  assert.equal(s.archiveWindows.value.length, 1);
});
test("回放槽位保留空位，缩小布局只关闭超出目标布局的窗口", (t) => {
  const { state: s, events } = component(
    t,
    "PlaybackWall.vue",
    async () => {},
    ["cells", "changeLayout", "layout", "dropChannel"],
    {
      items: [
        { id: "first", name: "A", slot: 0 },
        { id: "last", name: "A", slot: 8 },
      ],
    },
  );
  s.layout.value = 9;
  assert.equal(s.cells.value[1], null);
  assert.equal(s.cells.value[8].id, "last");
  s.changeLayout(4);
  assert.deepEqual(events, [["close", "last"]]);
  s.dropChannel(
    {
      preventDefault() {},
      dataTransfer: {
        getData(type) {
          assert.equal(type, "application/x-ls-aegis-channel");
          return "camera";
        },
      },
    },
    2,
  );
  assert.deepEqual(events[1], [
    "drop-channel",
    { channelId: "camera", slot: 2 },
  ]);
});
test("设备回放拖入同通道多个窗口，窗口标识与录像条目标识分离", async (t) => {
  const { state: s } = component(t, "Records.vue", async () => ({}), [
    "channels",
    "clipPool",
    "dropDeviceChannel",
    "appliedDeviceRange",
    "start",
    "end",
    "playbackClips",
    "closeDeviceWindow",
  ]);
  s.start.value = "2026-11-07T12:00:00";
  s.end.value = "2026-11-07T12:10:00";
  await vue.nextTick();
  s.appliedDeviceRange.value = recordRange.recordSearchRange(
    s.start.value,
    s.end.value,
  );
  s.channels.value = [
    { id: "channel", status: "online", deviceStatus: "online" },
  ];
  s.clipPool.value.channel = [
    {
      id: "record",
      channelId: "channel",
      start: "2026-11-07T04:00:00Z",
      end: "2026-11-07T04:10:00Z",
    },
  ];
  await s.dropDeviceChannel({ channelId: "channel", slot: 0 });
  await s.dropDeviceChannel({ channelId: "channel", slot: 2 });
  assert.equal(s.playbackClips.value.length, 2);
  assert.equal(s.playbackClips.value[0].id, "record");
  assert.notEqual(
    s.playbackClips.value[0].windowId,
    s.playbackClips.value[1].windowId,
  );
  s.closeDeviceWindow(s.playbackClips.value[0].windowId);
  assert.equal(s.playbackClips.value[0].slot, 2);
});
test("未完成索引也能先选择统一时间并播放，索引结果不覆盖用户时间", (t) => {
  const props = vue.reactive({ items: [{ id: "a", name: "A" }], ranges: {} });
  const { state: s } = component(
    t,
    "PlaybackWall.vue",
    async () => {},
    ["seekTime", "clock", "togglePlayback"],
    props,
  );
  s.seekTime("12:00:10");
  s.togglePlayback();
  assert.equal(s.clock.value.position, 43210);
  assert.equal(s.clock.value.playing, true);
  props.ranges.a = [{ start: 50000, end: 50100 }];
  assert.equal(s.clock.value.position, 43210);
});
test("多个回放窗口共享4个元数据读取名额，取消排队可立即退出且重复释放不超发", async () => {
  const active = await Promise.all(
    Array.from({ length: 4 }, () =>
      archiveProbePool.acquireArchiveProbe(new AbortController().signal),
    ),
  );
  const cancelled = new AbortController();
  const waiting = archiveProbePool.acquireArchiveProbe(cancelled.signal);
  cancelled.abort();
  assert.equal(await waiting, null);
  let granted = false;
  const next = archiveProbePool
    .acquireArchiveProbe(new AbortController().signal)
    .then((release) => {
      granted = true;
      return release;
    });
  await Promise.resolve();
  assert.equal(granted, false);
  active[0]();
  active[0]();
  const release = await next;
  assert.equal(granted, true);
  release();
  for (const done of active.slice(1)) done();
});

test("拖放落点明确声明复制效果，其他类型的拖拽不会被回放窗口截获", (t) => {
  const { state: s } = component(
    t,
    "PlaybackWall.vue",
    async () => {},
    ["dragOver", "dragTarget"],
    { items: [] },
  );
  let prevented = false;
  const dataTransfer = {
    types: ["application/x-ls-aegis-channel"],
    dropEffect: "none",
  };
  s.dragOver(
    {
      preventDefault() {
        prevented = true;
      },
      dataTransfer,
    },
    3,
  );
  assert.equal(prevented, true);
  assert.equal(dataTransfer.dropEffect, "copy");
  assert.equal(s.dragTarget.value, 3);
  s.dragOver(
    {
      preventDefault() {
        throw Error("must not accept external files");
      },
      dataTransfer: { types: ["Files"] },
    },
    0,
  );
});

test("录像起止范围按北京时间严格校验，支持五分钟、一小时与跨日24小时", () => {
  const five = recordRange.recordSearchRange(
    "2026-11-07T12:00:00",
    "2026-11-07T12:05:00",
  );
  assert.equal(five.to - five.from, 300);
  assert.equal(five.from, 43200);
  assert.equal(five.start, "2026-11-07T04:00:00.000Z");
  const cross = recordRange.recordSearchRange(
    "2026-11-07T23:58:00",
    "2026-11-08T00:03:00",
  );
  assert.equal(cross.to - cross.from, 300);
  assert.ok(cross.to > 86400);
  for (const [start, end] of [
    ["", ""],
    ["2026-02-30T12:00", "2026-03-01T12:00"],
    ["2026-11-07T12:00", "2026-11-07T12:00"],
    ["2026-11-07T12:00", "2026-11-08T12:01"],
  ])
    assert.throws(
      () => recordRange.recordSearchRange(start, end),
      /有效时间范围/,
    );
});
test("录像查询范围与时间轴缩放独立，全天、小时、分钟不改变播放时间", (t) => {
  const { state: s } = component(
    t,
    "PlaybackWall.vue",
    async () => {},
    [
      "ticks",
      "seek",
      "clock",
      "span",
      "coverage",
      "visibleSpan",
      "visibleStart",
      "setZoom",
    ],
    {
      items: [{ id: "a" }],
      rangeStart: 43200,
      rangeEnd: 43500,
      ranges: { a: [{ start: 43000, end: 43600 }] },
    },
  );
  assert.equal(s.span.value, 300);
  assert.equal(s.visibleSpan.value, 86400);
  assert.equal(s.ticks.value.at(-1).label, "24:00");
  assert.deepEqual([...s.coverage.value], [{ start: 43200, end: 43500 }]);
  s.setZoom(3600);
  assert.equal(s.visibleSpan.value, 3600);
  assert.equal(s.ticks.value[1].second - s.ticks.value[0].second, 600);
  s.setZoom(60);
  assert.equal(s.visibleSpan.value, 60);
  assert.equal(s.ticks.value[1].second - s.ticks.value[0].second, 10);
  assert.match(s.ticks.value[1].label, /\d{2}:\d{2}:\d{2}/);
  assert.equal(s.clock.value.position, 43200);
  s.seek(40000);
  assert.equal(s.clock.value.position, 43200);
  s.seek(50000);
  assert.equal(s.clock.value.position, 43499);
});
test("跨日进度条仍是一条，共同定位次日时间转换为大于24小时的日内秒数", (t) => {
  const { state: s } = component(
    t,
    "PlaybackWall.vue",
    async () => {},
    ["seekTime", "clock", "ticks"],
    { items: [{ id: "a" }], rangeStart: 86280, rangeEnd: 86580 },
  );
  s.seekTime("00:01:00");
  assert.equal(s.clock.value.position, 86460);
  assert.match(s.ticks.value.at(-1).label, /次日/);
});
test("平台录像先选择不读取元数据，拖入时沿用填写的起止范围查询并放入原槽位", async (t) => {
  let requests = 0;
  const job = {
    id: "j",
    channelId: "channel",
    channelName: "通道",
    kind: "scheduled",
    createdAt: "2026-11-07T04:00:00Z",
    files: [{ id: "f", name: "12-00-00.mp4", date: "2026-11-07" }],
  };
  const { state: s } = component(
    t,
    "RecordingCenter.vue",
    async (path) => {
      requests++;
      return { items: path.includes("kind=scheduled") ? [job] : [] };
    },
    [
      "jobs",
      "selectArchiveChannel",
      "dropArchiveChannel",
      "archiveStartInput",
      "archiveEndInput",
      "appliedArchiveRange",
      "archiveWindows",
    ],
    { section: "library" },
  );
  s.jobs.value = [job];
  s.archiveStartInput.value = "2026-11-07T12:00:00";
  s.archiveEndInput.value = "2026-11-07T12:05:00";
  s.selectArchiveChannel("channel");
  assert.equal(requests, 0);
  await s.dropArchiveChannel({ channelId: "channel", slot: 3 });
  assert.equal(
    s.appliedArchiveRange.value.to - s.appliedArchiveRange.value.from,
    300,
  );
  assert.equal(s.archiveWindows.value[0].slot, 3);
});
test("设备录像点击只选通道，拖入后只查询当前填写范围，非法起止不发请求", async (t) => {
  const posts = [];
  const { state: s } = component(
    t,
    "Records.vue",
    async (path, method, body) => {
      if (path === "/record-queries") {
        posts.push(body);
        return { taskId: "q" };
      }
      return {
        status: "succeeded",
        items: [
          {
            id: "r",
            channelId: "channel",
            start: "2026-11-07T04:00:00Z",
            end: "2026-11-07T04:05:00Z",
          },
        ],
      };
    },
    [
      "channels",
      "selectDeviceChannel",
      "dropDeviceChannel",
      "start",
      "end",
      "playbackClips",
      "appliedDeviceRange",
      "search",
    ],
  );
  s.channels.value = [
    { id: "channel", status: "online", deviceStatus: "online" },
  ];
  s.start.value = "2026-11-07T12:00:00";
  s.end.value = "2026-11-07T12:05:00";
  await vue.nextTick();
  await s.selectDeviceChannel("channel");
  assert.equal(posts.length, 0);
  await s.dropDeviceChannel({ channelId: "channel", slot: 2 });
  assert.equal(posts[0].end, "2026-11-07T04:05:00.000Z");
  assert.equal(s.playbackClips.value[0].slot, 2);
  s.end.value = s.start.value;
  await vue.nextTick();
  await s.search();
  assert.equal(posts.length, 1);
});

test("鼠标滚轮以指向时间缩放，不重查、不移动播放位置且可缩回全天", (t) => {
  const { state: s } = component(
    t,
    "PlaybackWall.vue",
    async () => {
      throw Error("zoom must not request data");
    },
    [
      "zoomBy",
      "visibleStart",
      "visibleSpan",
      "clock",
      "setZoom",
      "panTimeline",
    ],
    { items: [{ id: "a" }], rangeStart: 43200, rangeEnd: 43500 },
  );
  const position = s.clock.value.position;
  const event = {
    clientX: 250,
    currentTarget: {
      getBoundingClientRect() {
        return { left: 0, width: 1000 };
      },
    },
  };
  s.zoomBy(1, event);
  assert.equal(s.visibleSpan.value, 21600);
  assert.equal(s.visibleStart.value + s.visibleSpan.value * 0.25, 21600);
  assert.equal(s.clock.value.position, position);
  s.zoomBy(-1, event);
  assert.equal(s.visibleSpan.value, 86400);
  assert.equal(s.clock.value.position, position);
  s.setZoom(60);
  const before = s.visibleStart.value;
  s.panTimeline(1);
  assert.ok(s.visibleStart.value > before);
  assert.equal(s.clock.value.position, position);
});

test("左键拖动平移时间轴不改变播放与查询，单击仍可按秒定位", (t) => {
  const { state: s } = component(
    t,
    "PlaybackWall.vue",
    async () => {
      throw Error("pan must not query");
    },
    [
      "setZoom",
      "clock",
      "visibleStart",
      "startTimelineGesture",
      "moveTimelineGesture",
      "endTimelineGesture",
      "isPanning",
    ],
    { items: [{ id: "a" }], rangeStart: 43200, rangeEnd: 43500 },
  );
  s.setZoom(3600);
  const initial = s.visibleStart.value,
    position = s.clock.value.position,
    revision = s.clock.value.revision;
  const element = {
    getBoundingClientRect() {
      return { left: 0, width: 1000 };
    },
    setPointerCapture() {},
    hasPointerCapture() {
      return true;
    },
    releasePointerCapture() {},
  };
  const event = (x, type = "pointermove") => ({
    button: 0,
    pointerId: 1,
    clientX: x,
    currentTarget: element,
    type,
    preventDefault() {},
  });
  s.startTimelineGesture(event(500, "pointerdown"));
  s.moveTimelineGesture(event(300));
  assert.equal(s.visibleStart.value, initial + 720);
  assert.equal(s.clock.value.position, position);
  assert.equal(s.isPanning.value, true);
  s.endTimelineGesture(event(300, "pointerup"));
  assert.equal(s.clock.value.revision, revision);
  assert.equal(s.isPanning.value, false);
  const target = ((43217 - s.visibleStart.value) / 3600) * 1000;
  s.startTimelineGesture(event(target, "pointerdown"));
  s.endTimelineGesture(event(target, "pointerup"));
  assert.equal(s.clock.value.position, 43217);
  assert.equal(s.clock.value.revision, revision + 1);
});

test("统一回放控制支持十六倍、倒放、暂停和重新同步", (t) => {
  const { state: s } = component(
    t,
    "PlaybackWall.vue",
    async () => {},
    [
      "clock",
      "seek",
      "tick",
      "playForward",
      "pausePlayback",
      "rewindPlayback",
      "synchronizePlayback",
    ],
    {
      items: [{ id: "a" }],
      rangeStart: 43200,
      rangeEnd: 43500,
      ranges: { a: [{ start: 43200, end: 43500 }] },
    },
  );
  s.seek(43300);
  s.clock.value.speed = 16;
  s.rewindPlayback();
  assert.equal(s.clock.value.direction, -1);
  assert.equal(s.clock.value.playing, true);
  s.tick();
  assert.ok(s.clock.value.position <= 43300);
  s.pausePlayback();
  const pos = s.clock.value.position;
  s.tick();
  assert.equal(s.clock.value.position, pos);
  s.playForward();
  assert.equal(s.clock.value.direction, 1);
  assert.equal(s.clock.value.speed, 1);
  const revision = s.clock.value.revision;
  s.synchronizePlayback();
  assert.ok(s.clock.value.revision > revision);
  s.seek(43200);
  s.rewindPlayback();
  s.tick();
  assert.ok(s.clock.value.position >= 43200);
});

test("快进快退分别点击循环倍率并在切换方向时回到一倍", (t) => {
  const { state: s } = component(
    t,
    "PlaybackWall.vue",
    async () => {},
    ["clock", "seek", "cyclePlaybackRate", "playForward", "pausePlayback"],
    { items: [{ id: "a" }], rangeStart: 43200, rangeEnd: 43500 },
  );
  s.seek(43300);
  for (const direction of [1, -1]) {
    for (const speed of [1, 2, 4, 8, 16, 1]) {
      s.cyclePlaybackRate(direction);
      assert.equal(s.clock.value.speed, speed);
      assert.equal(s.clock.value.direction, direction);
      assert.equal(s.clock.value.playing, true);
    }
  }
  s.pausePlayback();
  s.cyclePlaybackRate(-1);
  assert.equal(s.clock.value.speed, 2);
  s.playForward();
  assert.equal(s.clock.value.speed, 1);
  s.cyclePlaybackRate(1);
  assert.equal(s.clock.value.speed, 1);
});

test("平台和设备回放最多九窗口，非法第十窗口拒绝且九路仍可替换", (t) => {
  const archive = component(
    t,
    "RecordingCenter.vue",
    async () => ({}),
    [
      "libraryChannel",
      "libraryDate",
      "addPlaybackChannel",
      "archiveWindows",
      "message",
    ],
    { section: "library" },
  ).state;
  archive.libraryChannel.value = "a";
  archive.libraryDate.value = "2026-11-07";
  const device = component(t, "Records.vue", async () => ({}), [
    "openClip",
    "playbackClips",
    "message",
  ]).state;
  const clip = {
    id: "r",
    channelId: "a",
    start: "2026-11-07T04:00:00Z",
    end: "2026-11-07T04:01:00Z",
  };
  for (let slot = 0; slot < 9; slot++) {
    archive.addPlaybackChannel(slot);
    device.openClip(clip, slot);
  }
  archive.addPlaybackChannel(9);
  device.openClip(clip, 9);
  assert.equal(archive.archiveWindows.value.length, 9);
  assert.equal(device.playbackClips.value.length, 9);
  assert.match(archive.message.value, /最多同时回放9路/);
  assert.match(device.message.value, /最多同时回放9路/);
  archive.addPlaybackChannel(8);
  device.openClip(clip, 8);
  assert.equal(archive.archiveWindows.value.length, 9);
  assert.equal(device.playbackClips.value.length, 9);
  const wall = component(
    t,
    "PlaybackWall.vue",
    async () => {},
    ["layouts", "layout", "cells", "changeLayout"],
    {
      items: Array.from({ length: 9 }, (_, slot) => ({
        id: String(slot),
        slot,
      })),
    },
  ).state;
  assert.deepEqual(wall.layouts, [1, 4, 9]);
  assert.equal(wall.layout.value, 9);
  wall.changeLayout(36);
  assert.equal(wall.layout.value, 9);
});

test("回放资源模糊搜索支持名称编号、多个关键词及全角大小写，不修改原窗口", (t) => {
  assert.equal(
    channelSearch.matchesChannelSearch(" nvr ００１ ", ["NVR通道001"]),
    true,
  );
  assert.equal(channelSearch.matchesChannelSearch("[a]", ["通道[a]"]), true);
  assert.equal(channelSearch.matchesChannelSearch("不存在", ["海康"]), false);
  const device = component(t, "Records.vue", async () => ({}), [
    "resourceSearch",
    "channels",
    "filteredChannels",
    "openClip",
    "playbackClips",
  ]).state;
  device.channels.value = [
    {
      id: "a",
      name: "海康出口",
      channelCode: "34020000001310000001",
      deviceName: "NVR",
    },
    { id: "b", name: "大厅", channelCode: "34020000001310000002" },
  ];
  device.openClip({
    id: "r",
    channelId: "a",
    start: "2026-11-07T04:00:00Z",
    end: "2026-11-07T04:01:00Z",
  });
  device.resourceSearch.value = "00002";
  assert.equal(device.filteredChannels.value[0].id, "b");
  assert.equal(device.playbackClips.value.length, 1);
  device.resourceSearch.value = "没有";
  assert.equal(device.filteredChannels.value.length, 0);
  assert.equal(device.playbackClips.value.length, 1);
  const archive = component(
    t,
    "RecordingCenter.vue",
    async () => ({}),
    ["resourceSearch", "jobs", "filteredLibraryChannels"],
    { section: "library" },
  ).state;
  archive.jobs.value = [
    {
      id: "j",
      channelId: "dev:34020000001310000001",
      channelName: "海康出口",
      files: [{ id: "f" }],
    },
  ];
  archive.resourceSearch.value = "出口 00001";
  assert.equal(archive.filteredLibraryChannels.value.length, 1);
  archive.resourceSearch.value = "";
  assert.equal(archive.filteredLibraryChannels.value.length, 1);
});

test("监控墙超过36路可翻页，换布局保持队列，离线与网络失败不误播，关闭取消迟到结果", async (t) => {
  const all = Array.from({ length: 70 }, (_, i) => ({
    id: String(i),
    name: "C" + i,
    status: "online",
    deviceStatus: "online",
  }));
  let fail = false,
    block = false;
  const pending = deferred();
  const api = async (path) => {
    const url = new URL("http://test" + path),
      id = url.searchParams.get("channelId");
    if (id !== null) {
      if (block) return pending.promise;
      if (fail) throw Error("network");
      return { items: all.filter((c) => c.id === id) };
    }
    return { items: all, total: all.length };
  };
  const { state: s } = component(t, "Monitoring.vue", api, [
    "openAll",
    "wallQueue",
    "wallPage",
    "wallPageCount",
    "wallBusy",
    "changeWallPage",
    "changeLayout",
    "layout",
    "slots",
    "closeAll",
    "batchNotice",
  ]);
  s.layout.value = 36;
  await s.openAll();
  assert.equal(s.wallQueue.value.length, 70);
  assert.equal(s.wallPageCount.value, 2);
  assert.equal(s.slots.value.length, 36);
  await s.changeWallPage(2);
  assert.equal(s.wallPage.value, 2);
  assert.equal(s.slots.value[0].id, "36");
  assert.equal(s.slots.value.filter(Boolean).length, 34);
  await s.changeLayout(9);
  assert.equal(s.wallPage.value, 5);
  assert.equal(s.wallPageCount.value, 8);
  assert.equal(s.slots.value[0].id, "36");
  fail = true;
  await s.changeWallPage(4);
  assert.equal(s.wallPage.value, 5);
  assert.equal(s.slots.value[0].id, "36");
  assert.match(s.batchNotice.value, /原预览已保留/);
  fail = false;
  block = true;
  const changing = s.changeWallPage(6);
  s.closeAll();
  pending.resolve({ items: [all[45]] });
  await changing;
  assert.equal(s.wallPage.value, 1);
  assert.equal(s.wallPageCount.value, 1);
  assert.ok(s.slots.value.every((c) => !c));
  assert.equal(s.wallBusy.value, false);
});

test("监控墙刷新保留页码和全部队列，仅恢复当前页，翻回隐藏页重新校验授权", async (t) => {
  const values = isolatedSessionStorage(t, {
    "ls-aegis:monitoring-windows:admin": JSON.stringify({
      layout: 36,
      active: 0,
      wallPage: 2,
      channels: Array.from({ length: 14 }, (_, i) => String(36 + i)),
      queue: Array.from({ length: 50 }, (_, i) => String(i)),
    }),
  });
  const requested = [];
  const { state: s } = component(
    t,
    "Monitoring.vue",
    async (path) => {
      const id = new URL("http://test" + path).searchParams.get("channelId");
      requested.push(id);
      return { items: [{ id, status: "online", deviceStatus: "online" }] };
    },
    [
      "restoreWindows",
      "wallPage",
      "wallPageCount",
      "wallQueue",
      "slots",
      "changeWallPage",
    ],
  );
  await s.restoreWindows();
  assert.equal(s.wallPage.value, 2);
  assert.equal(s.wallPageCount.value, 2);
  assert.equal(s.slots.value[0].id, "36");
  assert.equal(requested.length, 14);
  await s.changeWallPage(1);
  assert.equal(s.slots.value[0].id, "0");
  assert.equal(requested.length, 50);
  const saved = JSON.parse(values.get("ls-aegis:monitoring-windows:admin"));
  assert.equal(saved.wallPage, 1);
  assert.equal(saved.queue.length, 50);
});

test("实时监控拖入指定窗口支持重复通道，离线或无权落点不覆盖，翻页期间拒绝拖入", async (t) => {
  const channel = {
    id: "a",
    status: "online",
    deviceStatus: "online",
    name: "A",
  };
  const { state: s } = component(
    t,
    "Monitoring.vue",
    async () => ({ items: [] }),
    [
      "channels",
      "slots",
      "active",
      "dropOnSlot",
      "dragOverSlot",
      "dropTarget",
      "wallBusy",
      "batchNotice",
    ],
  );
  s.channels.value = [channel];
  const event = {
    dataTransfer: {
      getData: () => "a",
      types: ["application/x-ls-aegis-channel"],
      dropEffect: "",
    },
    preventDefault() {},
  };
  s.dragOverSlot(event, 3);
  assert.equal(s.dropTarget.value, 3);
  assert.equal(event.dataTransfer.dropEffect, "copy");
  await s.dropOnSlot(event, 3);
  await s.dropOnSlot(event, 0);
  assert.equal(s.slots.value[3].id, "a");
  assert.equal(s.slots.value[0].id, "a");
  s.wallBusy.value = true;
  await s.dropOnSlot(event, 2);
  assert.equal(s.slots.value[2], null);
  s.wallBusy.value = false;
  await s.dropOnSlot(
    { ...event, dataTransfer: { getData: () => "denied" } },
    2,
  );
  assert.equal(s.slots.value[2], null);
  assert.match(s.batchNotice.value, /离线或无权/);
});

test("监控画面翻页等待旧播放器释放，防止新旧页同时分配媒体", async (t) => {
  const all = Array.from({ length: 40 }, (_, i) => ({
    id: String(i),
    status: "online",
    deviceStatus: "online",
  }));
  const released = deferred();
  let retired = 0;
  const { state: s } = component(
    t,
    "Monitoring.vue",
    async (path) => {
      const id = new URL("http://test" + path).searchParams.get("channelId");
      return {
        items: id ? all.filter((c) => c.id === id) : all,
        total: all.length,
      };
    },
    [
      "openAll",
      "changeWallPage",
      "registerMonitorPlayer",
      "slots",
      "wallBusy",
      "wallPage",
      "layout",
    ],
  );
  s.layout.value = 36;
  await s.openAll();
  s.registerMonitorPlayer(0, {
    retire() {
      retired++;
      return released.promise;
    },
  });
  const changing = s.changeWallPage(2);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(retired, 1);
  assert.equal(s.wallPage.value, 1);
  assert.equal(s.slots.value[0].id, "0");
  released.resolve();
  await changing;
  assert.equal(s.wallPage.value, 2);
  assert.equal(s.slots.value[0].id, "36");
  assert.equal(s.wallBusy.value, false);
});

test("录像时长跨窗口共享读取，关闭一个不取消另一个，刷新复用且按账号隔离", async (t) => {
  isolatedSessionStorage(t);
  archiveDurationCache.clearArchiveDurationCache();
  t.after(() => archiveDurationCache.clearArchiveDurationCache());
  const result = deferred();
  let reads = 0;
  const probe = async () => {
    reads++;
    return result.promise;
  };
  const first = new AbortController(),
    second = new AbortController();
  const a = archiveDurationCache.readArchiveDuration(
    "cache-owner",
    "/one.mp4",
    probe,
    first.signal,
  );
  const b = archiveDurationCache.readArchiveDuration(
    "cache-owner",
    "/one.mp4",
    probe,
    second.signal,
  );
  await Promise.resolve();
  assert.equal(reads, 1);
  first.abort();
  assert.equal(await a, 0);
  result.resolve(123);
  assert.equal(await b, 123);
  assert.equal(
    await archiveDurationCache.readArchiveDuration(
      "cache-owner",
      "/one.mp4",
      probe,
      new AbortController().signal,
    ),
    123,
  );
  assert.equal(reads, 1);
  archiveDurationCache.clearArchiveDurationCache();
  assert.equal(
    archiveDurationCache.cachedArchiveDuration("cache-owner", "/one.mp4"),
    123,
  );
  assert.equal(
    archiveDurationCache.cachedArchiveDuration("other-owner", "/one.mp4"),
    undefined,
  );
});

test("全部窗口取消会终止索引，失败不缓存，不会把迟到结果写回", async (t) => {
  isolatedSessionStorage(t);
  archiveDurationCache.clearArchiveDurationCache();
  t.after(() => archiveDurationCache.clearArchiveDurationCache());
  const result = deferred();
  let producerSignal;
  const controller = new AbortController();
  const read = archiveDurationCache.readArchiveDuration(
    "owner",
    "/cancel.mp4",
    async (signal) => {
      producerSignal = signal;
      return result.promise;
    },
    controller.signal,
  );
  await Promise.resolve();
  controller.abort();
  assert.equal(await read, 0);
  assert.equal(producerSignal.aborted, true);
  result.resolve(99);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(
    archiveDurationCache.cachedArchiveDuration("owner", "/cancel.mp4"),
    undefined,
  );
  assert.equal(
    await archiveDurationCache.readArchiveDuration(
      "owner",
      "/cancel.mp4",
      async () => 0,
      new AbortController().signal,
    ),
    0,
  );
  assert.equal(
    archiveDurationCache.cachedArchiveDuration("owner", "/cancel.mp4"),
    undefined,
  );
});

test("按首窗口选定初始时间后，补齐更早索引及后排通道不反复跳转", async (t) => {
  const props = vue.reactive({
    items: [{ id: "a" }],
    ranges: {},
    rangeStart: 0,
    rangeEnd: 86400,
  });
  const { state: s } = component(
    t,
    "PlaybackWall.vue",
    async () => {},
    ["clock", "seek"],
    props,
  );
  props.ranges.a = [{ start: 43260, end: 43300 }];
  await vue.nextTick();
  assert.equal(s.clock.value.position, 43260);
  assert.equal(s.clock.value.playing, false);
  props.ranges.a = [
    { start: 43200, end: 43230 },
    { start: 43260, end: 43300 },
  ];
  await vue.nextTick();
  assert.equal(s.clock.value.position, 43260);
  props.items.push({id:'b'});
  props.ranges.b = [{start:100,end:200}];
  await vue.nextTick();
  assert.equal(s.clock.value.position, 43260);
  s.seek(43320);
  props.ranges.a = [{ start: 43100, end: 43130 }, ...props.ranges.a];
  await vue.nextTick();
  assert.equal(s.clock.value.position, 43320);
});

test('基准严格按窗口顺序，等待前格索引，空窗口逐级回退至第二第三第四格',async t=>{
  const props=vue.reactive({items:[{id:'b',slot:1},{id:'a',slot:0},{id:'d',slot:3},{id:'c',slot:2}],ranges:{b:[{start:100,end:150}],c:[{start:700,end:750}],d:[{start:900,end:950}]},pending:{a:true,b:false,c:false,d:false}});
  const {state:s}=component(t,'PlaybackWall.vue',async()=>{},['clock','referenceId','seek'],props);
  assert.equal(s.clock.value.position,0,'第二格先返回不能越过仍在读取的第一格');
  props.ranges.a=[{start:500,end:550}];await vue.nextTick();
  assert.equal(s.referenceId.value,'a');assert.equal(s.clock.value.position,500,'第一格优先，不能选全局最早的第二格');
  props.ranges.a=[];props.pending.a=false;await vue.nextTick();
  assert.equal(s.referenceId.value,'b');assert.equal(s.clock.value.position,100);
  props.ranges.b=[];await vue.nextTick();assert.equal(s.referenceId.value,'c');assert.equal(s.clock.value.position,700);
  props.ranges.c=[];await vue.nextTick();assert.equal(s.referenceId.value,'d');assert.equal(s.clock.value.position,900);
  props.ranges.d=[];await vue.nextTick();assert.equal(s.referenceId.value,null);assert.equal(s.clock.value.position,900);
});

test('基准确定后手动定位及已开始播放不被新增前排窗口覆盖',async t=>{
  const props=vue.reactive({items:[{id:'b',slot:1}],ranges:{b:[{start:100,end:200}]},pending:{b:false}});
  const {state:s}=component(t,'PlaybackWall.vue',async()=>{},['clock','seek','togglePlayback'],props);
  assert.equal(s.clock.value.position,100);s.seek(150);
  props.items.push({id:'a',slot:0});props.ranges.a=[{start:500,end:600}];props.pending.a=false;await vue.nextTick();
  assert.equal(s.clock.value.position,150);
  s.togglePlayback();props.ranges.b=[{start:10,end:200}];await vue.nextTick();assert.equal(s.clock.value.position,150);
});

test('索引期间先点击播放，基准就绪后仍定位首个有效窗口并继续播放',async t=>{
  const props=vue.reactive({items:[{id:'a',slot:0}],ranges:{},pending:{a:true}});
  const {state:s}=component(t,'PlaybackWall.vue',async()=>{},['clock','togglePlayback'],props);
  s.togglePlayback();props.ranges.a=[{start:300,end:400}];await vue.nextTick();
  assert.equal(s.clock.value.position,300);assert.equal(s.clock.value.playing,true);
  props.ranges.a=[{start:100,end:400}];await vue.nextTick();assert.equal(s.clock.value.position,300);
});

test("录像索引乱序完成不先播后段，补充新文件不会清空或重载当前画面",async t=>{
  isolatedSessionStorage(t); archiveDurationCache.clearArchiveDurationCache();
  t.after(()=>archiveDurationCache.clearArchiveDurationCache());
  const originalDocument=Object.getOwnPropertyDescriptor(globalThis,'document');
  const waiting=new Map();
  Object.defineProperty(globalThis,'document',{configurable:true,value:{createElement(){
    const probe={duration:0,onloadedmetadata:null,onerror:null,removeAttribute(){},load(){}};
    Object.defineProperty(probe,'src',{set(url){waiting.set(url,probe);}});return probe;
  }}});
  t.after(()=>{if(originalDocument)Object.defineProperty(globalThis,'document',originalDocument);else delete globalThis.document;});
  const cached='/flicker-cached.mp4',earliest='/flicker-earliest.mp4',future='/flicker-new.mp4';
  await archiveDurationCache.readArchiveDuration('admin',cached,async()=>30,new AbortController().signal);
  const props=vue.reactive({channelId:'a',channelName:'A',date:'2026-11-07',files:[{id:'first',name:'00-01-40-0.mp4',date:'2026-11-07',url:earliest},{id:'second',name:'00-03-20-0.mp4',date:'2026-11-07',url:cached}],clock:{position:0,playing:false,speed:1,muted:true,direction:1,revision:0}});
  const {state:s}=component(t,'ArchiveDayPlayer.vue',async()=>{},['segments','video','current','syncArchive','loaded','indexing'],props);
  for(let i=0;i<100&&!waiting.has(earliest);i++)await new Promise(r=>setImmediate(r));
  assert.equal(s.segments.value.length,0,'缓存的后段不能越过尚未确认的首段抢先显示');
  const first=waiting.get(earliest);first.duration=30;first.onloadedmetadata();
  for(let i=0;i<100&&s.indexing.value;i++)await new Promise(r=>setImmediate(r));
  assert.deepEqual(s.segments.value.map(segment=>segment.start),[100,200]);
  let loads=0;const video={readyState:4,paused:true,ended:false,currentTime:0,playbackRate:1,load(){loads++;},removeAttribute(){this.src=null;},pause(){this.paused=true;},async play(){this.paused=false;}};
  s.video.value=video;props.clock.position=110;props.clock.revision++;
  s.syncArchive();s.loaded();await vue.nextTick();
  assert.equal(s.current.value.id,'first');const loaded=loads;
  props.files.push({id:'new',name:'00-05-00-0.mp4',date:'2026-11-07',url:future});
  for(let i=0;i<100&&!waiting.has(future);i++)await new Promise(r=>setImmediate(r));
  assert.equal(s.current.value.id,'first');assert.equal(loads,loaded);
  const next=waiting.get(future);next.duration=30;next.onloadedmetadata();
  for(let i=0;i<100&&s.indexing.value;i++)await new Promise(r=>setImmediate(r));
  assert.equal(s.current.value.id,'first');assert.equal(loads,loaded);assert.equal(video.currentTime,10);
});

test("缓存索引同步恢复时立即发布覆盖范围，避免时间轴停留零点",async t=>{
  isolatedSessionStorage(t);archiveDurationCache.clearArchiveDurationCache();t.after(()=>archiveDurationCache.clearArchiveDurationCache());
  await archiveDurationCache.readArchiveDuration('admin','/cached-first-frame.mp4',async()=>60,new AbortController().signal);
  const {events}=component(t,'ArchiveDayPlayer.vue',async()=>{},[],{channelId:'cached',channelName:'缓存通道',date:'2026-11-07',files:[{id:'cached',name:'22-00-00-0.mp4',date:'2026-11-07',url:'/cached-first-frame.mp4'}]});
  assert.ok(events.some(([name,ranges])=>name==='ranges'&&ranges[0]?.start===79200));
});


test('AI按线索检索录像要求时间范围，异步结果包含原文件并可取消',async t=>{
 const calls=[];const result={id:'history-search',status:'succeeded',phase:'finished',items:[{id:'frame',recording:{fileId:'file',offsetSeconds:15}}],total:1,method:'按线索抽样检索',sampleCount:4,modelCalls:1,fileCount:1,candidateFiles:1,truncated:false,error:null};
 const {state:s}=component(t,'AiSearch.vue',async(path,method,data)=>{calls.push({path,method,data});return result},['text','from','to','search','error','busy','historyJob','results','cancelHistory']);
 s.text.value='查找红色汽车';await s.search();assert.match(s.error.value,/开始时间/);assert.equal(calls.length,0);
 s.from.value='2026-11-08T01:00';s.to.value='2026-11-08T01:10';await s.search();assert.equal(calls[0].path,'/ai/history-searches');assert.equal(calls[0].data.question,'查找红色汽车');assert.equal(s.results.value[0].recording.offsetSeconds,15);assert.equal(s.busy.value,false);
 await s.cancelHistory();assert.ok(calls.some(c=>c.path==='/ai/history-searches/history-search/cancel'));
});


test('AI本地接入独立保存，不启用大模型或提交未保存的密钥',async t=>{
 const config={version:1,enabled:false,localEnabled:true,model:'deepseek-flash',hasKey:false,timeoutSeconds:60,retentionDays:7};const writes=[];
 const {state:s}=component(t,'AiModels.vue',async(path,method,data)=>{if(method==='PUT'){writes.push(data);return {...config,...data,version:2};}return config;},['settings','apiKey','form','localEnabled','saveLocal','message']);
 s.settings.value=config;s.apiKey.value='unsaved-secret';s.form.value.enabled=true;s.localEnabled.value=false;await s.saveLocal();
 assert.equal(writes[0].enabled,false);assert.equal(writes[0].localEnabled,false);assert.equal(writes[0].apiKey,undefined);assert.match(s.message.value,/本地接入/);
});


test('AI详情保留录像定位和关闭清理',async t=>{
 const props={job:{id:'sample',status:'succeeded',recording:{offsetSeconds:17}}};
 const {state:s}=component(t,'AiResultDialog.vue',async()=>{},['video','locateRecording','stopRecording'],props);
 let paused=0,removed=0,loaded=0;s.video.value={duration:60,currentTime:0,pause(){paused++},removeAttribute(){removed++},load(){loaded++}};
 s.locateRecording();assert.equal(s.video.value.currentTime,17);s.stopRecording();assert.equal(paused,1);assert.equal(removed,1);assert.equal(loaded,1);s.video.value=undefined;
});
test('AI上传图片使用千问，不再请求旧检测接口',async t=>{
 const calls=[];const job={id:'local-picture',status:'queued',model:'local-qwen-test'};
 const {state:s}=component(t,'AiAnalyses.vue',async(path,method,data)=>{calls.push({path,method,data});if(path==='/ai/analyses'&&method==='POST')return job;if(path.startsWith('/ai/analyses?'))return {items:[job],total:1};if(path==='/ai/status')return {enabled:false,hasKey:false,localEnabled:true,local:{qwenReady:true}};return job;},['source','upload','localImage','submit','selected']);
 s.source.value='upload';s.upload.value={image:'data:image/jpeg;base64,test',name:'test.jpg'};await s.submit();
 const request=calls.find(c=>c.path==='/ai/analyses'&&c.method==='POST');assert.equal(request.data.localAnalysis,true);assert.equal(request.data.reference,undefined);assert.equal(calls.filter(c=>c.path.endsWith('/detections')).length,0);assert.equal(s.selected.value.id,'local-picture');
});

test('AI上传参考图在两种检索范围均走本地准备，不要求云端模型',async t=>{
 for(const target of ['indexed','history']){
  const calls=[];
  const {state:s}=component(t,'AiSearch.vue',async(path,method,data)=>{calls.push({path,method,data});if(path==='/ai/analyses'||path==='/ai/analyses/local-ref')return {id:'local-ref',status:'succeeded'};if(path==='/ai/search')return {items:[],total:0,method:'本地',truncated:false};return {id:'history',status:'succeeded',items:[],total:0,method:'本地'};},['target','mode','referenceMode','reference','referenceId','from','to','search','error','busy']);
  s.target.value=target;s.mode.value='image';s.referenceMode.value='upload';s.referenceId.value='';s.reference.value={image:'data:image/jpeg;base64,test',name:'ref.jpg'};s.from.value='2026-11-08T05:00';s.to.value='2026-11-08T05:03';
  await s.search();const prepare=calls.find(c=>c.path==='/ai/analyses'&&c.method==='POST');assert.equal(prepare.data.reference,true);assert.equal(prepare.data.localReference,true);assert.equal(s.error.value,'');assert.equal(s.busy.value,false);
 }
});
test('AI新查询失败后不展示上一查询结果',async t=>{
 const {state:s}=component(t,'AiSearch.vue',async()=>{throw Error('检索暂不可用')},['target','mode','text','from','to','results','total','searched','method','search','error']);
 s.target.value='indexed';s.mode.value='text';s.text.value='汽车';s.from.value='';s.to.value='';s.results.value=[{id:'old'}];s.total.value=1;s.searched.value=true;s.method.value='old';await s.search();
 assert.equal(s.results.value.length,0);assert.equal(s.total.value,0);assert.equal(s.searched.value,false);assert.equal(s.method.value,'');assert.match(s.error.value,/检索暂不可用/);
});
test('AI历史记录打开复用现有查询，不创建新分析任务', async t=>{
 const calls=[];const record={id:'saved-query',status:'succeeded',items:[{id:'frame'}],total:1,method:'本地',sampleCount:1};
 const {state:s}=component(t,'AiSearch.vue',async(path,method,data)=>{calls.push({path,method,data});return record;},['openHistory','results','historyJob']);
 await s.openHistory('saved-query');
 assert.equal(s.results.value[0].id,'frame');assert.equal(s.historyJob.value.id,'saved-query');assert.equal(calls.filter(c=>c.path.includes('/saved-query?')).length,1);assert.ok(calls.every(c=>c.method!=='POST'));
});
test('AI画面预览离开当前列表仍刷新待完成任务，撤权清理画面', async t=>{
 let denied=false;
 const {state:s}=component(t,'AiAnalyses.vue',async(path)=>{if(path.startsWith('/ai/analyses?'))return {items:[],total:0};if(path==='/ai/status')return {enabled:false};if(denied)throw new ApiError('无权访问',403);return {id:'active',status:'succeeded',imageUrl:'/frame.jpg'};},['activeJob','selected','load']);
 s.activeJob.value={id:'active',status:'queued'};await s.load();assert.equal(s.activeJob.value.status,'succeeded');
 s.activeJob.value.status='queued';denied=true;await s.load();assert.equal(s.activeJob.value,null);assert.equal(s.selected.value,null);
});
test('AI历史记录加载区分等待和失败，迟到响应不覆盖新结果',async t=>{
 let resolveOld; let fail=false; let count=0;
 const {state:s}=component(t,'AiHistoryRecords.vue',async()=>{if(fail)throw new ApiError('暂不可用',503);if(++count===1)return new Promise(r=>resolveOld=r);return {items:[{id:'new'}]};},['load','loading','error','records']);
 const pending=s.load();assert.equal(s.loading.value,true);await s.load();resolveOld({items:[{id:'old'}]});await pending;assert.equal(s.records.value[0].id,'new');assert.equal(s.loading.value,false);
 fail=true;await s.load();assert.match(s.error.value,/暂不可用/);assert.equal(s.records.value[0].id,'new');assert.equal(s.loading.value,false);
});
test('AI打开历史结果失败时不残留另一次查询画面',async t=>{
 const {state:s}=component(t,'AiSearch.vue',async()=>{throw new ApiError('无权访问',403)},['openHistory','results','total','searched','historyJob','method','error']);
 s.results.value=[{id:'old'}];s.total.value=1;s.searched.value=true;s.historyJob.value={id:'old'};s.method.value='旧结果';await s.openHistory('denied');assert.equal(s.results.value.length,0);assert.equal(s.total.value,0);assert.equal(s.historyJob.value,null);assert.equal(s.searched.value,false);assert.equal(s.method.value,'');assert.match(s.error.value,/无权访问/);
});

test('AI通道分析提交完整时段，本地不启用复核且不再按单帧分析',async t=>{
 const calls=[];const {state:s}=component(t,'AiAnalyses.vue',async()=>{},['source','channel','localImage','question','submit','rangeResults','rangeFrom','rangeTo']);
 s.source.value='channel';s.channel.value={id:'channel'};s.rangeFrom.value='2026-11-08T10:00';s.rangeTo.value='2026-11-08T11:00';s.question.value='红色汽车';
 s.rangeResults.value={start:async value=>calls.push(value)};await s.submit();assert.deepEqual(calls[0],{channelId:'channel',from:'2026-11-08T10:00',to:'2026-11-08T11:00',question:'红色汽车',verify:false});
 s.localImage.value=false;await s.submit();assert.equal(calls[1].verify,true);
});
test('AI合并记录入口保留查询标识并切到对应页面',async t=>{
 const analysis=component(t,'AiAnalyses.vue',async()=>{},['recordedSearchId','openRecordedSearch']);analysis.state.openRecordedSearch('saved');assert.equal(analysis.state.recordedSearchId.value,'saved');assert.deepEqual(analysis.events.at(-1),['navigate','aiSearch']);
 const search=component(t,'AiSearch.vue',async()=>{},['showRecords','combinedRecordsView']);search.state.showRecords();assert.equal(search.state.combinedRecordsView.value,'history');assert.deepEqual(search.events.at(-1),['navigate','aiAnalysis']);
});

test('AI录像选帧校验真实覆盖，暂停读取精确偏移且空档不输出旧帧',async t=>{
 const props={channelId:'c',channelName:'摄像机'};const {state:s,events}=component(t,'AiRecordingSource.vue',async(path)=>({items:path.includes('scheduled')?[{id:'job',channelId:'c',files:[{id:'file',date:'2026-11-08',name:'2026-11-08-01-00-00-0.mp4'}]}]:[]}),['load','date','time','selected','video','metadataLoaded','locate','notice','ready','pauseAndSelect'],props);
 s.date.value='2026-11-08';await vue.nextTick();await s.load();let pauses=0;const element={dataset:{fileKey:s.selected.value.key},duration:30,currentTime:0,seeking:false,pause(){pauses++},removeAttribute(){},load(){}};s.video.value=vue.markRaw(element);s.metadataLoaded({currentTarget:element});element.currentTime=17.125;const frame=s.pauseAndSelect();assert.equal(frame.frameOffset,17.125);assert.equal(frame.recordingFileId,'file');assert.equal(pauses,1);
 s.time.value='01:01:00';s.locate();s.metadataLoaded({currentTarget:element});assert.equal(s.ready.value,false);assert.match(s.notice.value,/无录像/);assert.equal(events.filter(e=>e[0]==='frame').at(-1)[1],null);
});
test('AI拖入通道只接受本站拖动项，未定位录像不能发起分析',async t=>{
 const calls=[];const {state:s}=component(t,'AiAnalyses.vue',async(path,method)=>{calls.push({path,method})},['draggedChannel','channel','dropRecording','recordingFrame','submit','sourceError','status']);
 s.draggedChannel.value={id:'own',name:'摄像机'};s.dropRecording({dataTransfer:{getData:()=> 'foreign'}});assert.equal(s.channel.value,null);s.dropRecording({dataTransfer:{getData:()=> 'own'}});assert.equal(s.channel.value.id,'own');await vue.nextTick();s.status.value={recordingFrames:true};await s.submit();assert.equal(calls.length,0);assert.match(s.sourceError.value,/准备/);
});

test('AI时间段查找校验范围并提交单通道真实检索接口',async t=>{
 const calls=[];const done={id:'range-1',status:'succeeded',phase:'finished',items:[],total:0,truncated:false};
 const {state:s}=component(t,'AiRangeResults.vue',async(path,method,data)=>{calls.push({path,method,data});return done;},['start','job','error']);
 const value={channelId:'c',from:'2026-11-08T10:00',to:'2026-11-08T11:00',question:'白色汽车',verify:false};
 await assert.rejects(()=>s.start({...value,to:'2026-11-08T09:00'}),/起止时间/);assert.equal(calls.length,0);
 await assert.rejects(()=>s.start({...value,question:' '}),/物品/);
 await s.start(value);assert.equal(calls[0].path,'/ai/history-searches');assert.deepEqual(calls[0].data.channelIds,['c']);assert.equal(calls[0].data.verify,false);assert.equal(calls[0].data.question,'白色汽车');assert.equal(Date.parse(calls[0].data.to)-Date.parse(calls[0].data.from),3600000);assert.equal(s.job.value.id,'range-1');
});
test('AI时段候选打开原有分析详情，不重新调用模型',async t=>{
 const calls=[];const {state:s,events}=component(t,'AiRangeResults.vue',async(path,method)=>{calls.push({path,method});return {id:'match',status:'succeeded',recording:{offsetSeconds:7}};},['details']);
 await s.details({id:'match',historySample:{searchId:'range-1'}});assert.equal(calls[0].path,'/ai/history-searches/range-1/samples/match');assert.equal(calls[0].method,undefined);assert.equal(events.at(-1)[0],'details');
});

test('AI参考图与通道时段一起提交，无文字也可检索，复用参考图不触发大模型',async t=>{
 const calls=[];const result={id:'range-image',status:'succeeded',items:[],total:0};
 const {state:s}=component(t,'AiRangeResults.vue',async(path,method,data)=>{calls.push({path,method,data});return path==='/ai/analyses'?{id:'reference-1',status:'succeeded'}:result;},['start']);
 const value={channelId:'camera-1',from:'2026-11-08T10:00',to:'2026-11-08T10:05',question:'',verify:false,reference:{image:'data:image/jpeg;base64,test',name:'reference.jpg'}};
 await s.start(value);let post=calls.find(c=>c.path==='/ai/history-searches'&&c.method==='POST');
 assert.equal(post.data.referenceId,'reference-1');assert.deepEqual(post.data.channelIds,['camera-1']);assert.equal(post.data.verify,false);
 const reference=calls.find(c=>c.path==='/ai/analyses');assert.equal(reference.data.localReference,true);assert.equal(reference.data.localAnalysis,undefined);
 await s.start({...value,question:'红色标志，不是灯光'});post=calls.filter(c=>c.path==='/ai/history-searches'&&c.method==='POST').at(-1);assert.equal(post.data.question,'红色标志，不是灯光');assert.equal(post.data.referenceId,'reference-1');assert.equal(calls.filter(c=>c.path==='/ai/analyses').length,1);
});

test('AI查看已有检索仅恢复查询状态，不取消或重建用户任务',async t=>{
 const calls=[];const running={id:'existing-query',status:'running',phase:'sampling',params:{question:'红色标志'},items:[],total:0};
 const {state:s}=component(t,'AiRangeResults.vue',async(path,method)=>{calls.push({path,method});return path==='/ai/history-searches'?{items:[running]}:running;},['resume','job','existingQuestion']);
 await s.resume();assert.equal(s.job.value.id,'existing-query');assert.equal(s.existingQuestion.value,'红色标志');assert.ok(calls.every(c=>c.method===undefined));
});
