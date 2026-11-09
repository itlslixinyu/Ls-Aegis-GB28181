<script setup lang="ts">
import {
  ref,
  computed,
  watch,
  nextTick,
  onMounted,
  onUnmounted,
  defineAsyncComponent,
} from "vue";
import AppIcon from "./components/AppIcon.vue";
const AiAnalyses = defineAsyncComponent(
  () => import("./components/AiAnalyses.vue"),
);
const AiWorkspace = defineAsyncComponent(
  () => import("./components/AiWorkspace.vue"),
);
const AiModels = defineAsyncComponent(
  () => import("./components/AiModels.vue"),
);
import { appearance, layout, resetAppearance, themes } from "./appearance";
import BrandMark from "./components/BrandMark.vue";
import {
  api,
  currentUser,
  authNotice,
  setSession,
  logout,
  changeOwnPassword,
  messageOf,
  type User,
  can,
  roleLabel,
  refreshCurrentUser,
} from "./api";
import Subscriptions from "./components/Subscriptions.vue";
const Trajectories = defineAsyncComponent(
  () => import("./components/Trajectories.vue"),
);
import Groups from "./components/Groups.vue";
import Alarms from "./components/Alarms.vue";
const DeviceMap = defineAsyncComponent(
  () => import("./components/DeviceMap.vue"),
);
import RecordingCenter from "./components/RecordingCenter.vue";
import Records from "./components/Records.vue";
import Cascade from "./components/Cascade.vue";
import Monitoring from "./components/Monitoring.vue";
import Devices from "./components/Devices.vue";
import Administration from "./components/Administration.vue";
import PersonalDetails from "./components/PersonalDetails.vue";
import { connectAuthorizationUpdates } from "./authorization-sync";
const ready = ref(false),
  setup = ref(false),
  username = ref(""),
  password = ref(""),
  error = ref(""),
  busy = ref(false),
  view = ref("devices");
const collapsed = ref(false),
  navigationOpen = ref(false);
const expandedGroup = ref<string | null>("基础管理"),
  openedPages = ref(["devices"]),
  menuQuery = ref("");
const appearanceDrawer = ref<HTMLDialogElement>();
const accountPanel = ref<HTMLElement>();
const profileDialog = ref<HTMLDialogElement>();
const currentPassword = ref("");
const newPassword = ref("");
const confirmPassword = ref("");
const profileBusy = ref(false);
const profileError = ref("");
const profileOpen = ref(false),
  profileTab = ref("details"),
  detailsBusy = ref(false);
const profileLocked = computed(() => profileBusy.value || detailsBusy.value);
function clearProfileForm() {
  profileOpen.value = false;
  detailsBusy.value = false;
  currentPassword.value = newPassword.value = confirmPassword.value = "";
  profileError.value = "";
}
function openProfile() {
  accountPanel.value?.hidePopover();
  clearProfileForm();
  profileTab.value = "details";
  profileOpen.value = true;
  profileDialog.value?.showModal();
}
async function saveOwnPassword() {
  if (profileBusy.value) return;
  profileError.value = "";
  if (newPassword.value !== confirmPassword.value) {
    profileError.value = "两次输入的新密码不一致";
    return;
  }
  profileBusy.value = true;
  try {
    await changeOwnPassword(currentPassword.value, newPassword.value);
    clearProfileForm();
  } catch (error) {
    profileError.value = messageOf(error);
  } finally {
    profileBusy.value = false;
  }
}
const workspaceFullscreen = ref(false);
const fullscreenNotice = ref("");
function syncWorkspaceFullscreen() {
  workspaceFullscreen.value =
    document.fullscreenElement === document.documentElement;
}
onMounted(() =>
  document.addEventListener("fullscreenchange", syncWorkspaceFullscreen),
);
onUnmounted(() =>
  document.removeEventListener("fullscreenchange", syncWorkspaceFullscreen),
);
async function toggleWorkspaceFullscreen() {
  fullscreenNotice.value = "";
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await document.documentElement.requestFullscreen();
  } catch {
    fullscreenNotice.value = "当前浏览器未能切换全屏";
  }
}
const menuSearch = ref<HTMLDialogElement>(),
  pageTabs = ref<HTMLElement>();
const mobileMenuButton = ref<HTMLButtonElement>(),
  sidebar = ref<HTMLElement>();
function closeNavigation() {
  const wasOpen = navigationOpen.value;
  navigationOpen.value = false;
  if (wasOpen) void nextTick(() => mobileMenuButton.value?.focus());
}
function toggleMobileNavigation() {
  if (navigationOpen.value) return closeNavigation();
  collapsed.value = false;
  navigationOpen.value = true;
  void nextTick(() =>
    sidebar.value?.querySelector<HTMLButtonElement>("nav button")?.focus(),
  );
}
// Keep daily video operation first, followed by events, operations and setup.
const labels: Record<string, string> = {
  config: "接入配置",
  users: "用户管理",
  groups: "分组授权",
  devices: "国标设备",
  monitoring: "实时监控",
  plans: "录像计划",
  records: "录像回放",
  jobs: "录像任务",
  subscriptions: "订阅管理",
  alarms: "告警管理",
  map: "设备地图",
  tracks: "历史轨迹",
  cascade: "国标级联",
  audit: "操作审计",
  aiRecords: "分析记录",
  aiSearch: "录像检索",
  aiModels: "模型配置",
};
const navigation = computed(() =>
  [
    {
      title: "视频业务",
      icon: "monitoring",
      items: ["monitoring", "records"],
    },
    { title: "录像设置", icon: "plans", items: ["plans", "jobs"] },
    {
      title: "智能检索",
      icon: "ai",
      items: ["aiSearch", "aiRecords", "aiModels"],
    },
    {
      title: "事件与位置",
      icon: "alarms",
      items: ["subscriptions", "alarms", "map", "tracks"],
    },
    { title: "平台运维", icon: "audit", items: ["cascade", "audit"] },
    {
      title: "基础管理",
      icon: "config",
      items: ["config", "users", "groups", "devices"],
    },
  ]
    .map((group) => ({
      ...group,
      items: group.items.filter((key) =>
        can(
          (
            {
              config: "system.configure",
              users: "users.manage",
              groups: "groups.manage",
              devices: "devices.view",
              monitoring: "live.preview",
              plans: "plans.manage",
              records: "recording.view",
              jobs: "recording.view",
              aiRecords: "ai.view",
              aiSearch: "ai.view",
              aiModels: "ai.configure",
              alarms: "alarms.view",
              subscriptions: "subscriptions.view",
              tracks: "tracks.view",
              map: "map.view",
              cascade: "cascade.manage",
              audit: "audit.view",
            } as Record<string, string>
          )[key],
        ),
      ),
    }))
    .filter((group) => group.items.length),
);
watch(
  navigation,
  (groups) => {
    const allowed = groups.flatMap((g) => g.items);
    openedPages.value = openedPages.value.filter((page) =>
      allowed.includes(page),
    );
    if (!allowed.includes(view.value)) view.value = allowed[0] || "";
  },
  { flush: "sync" },
);
let authorizationTimer: ReturnType<typeof setInterval> | undefined;
const authorizationRevision = ref(0);
let stopAuthorizationUpdates = () => {};
watch(
  () => currentUser.value?.id,
  () => {
    stopAuthorizationUpdates();
    stopAuthorizationUpdates = connectAuthorizationUpdates(
      () => authorizationRevision.value++,
    );
  },
  { immediate: true },
);
onMounted(() => {
  authorizationTimer = setInterval(
    () => void refreshCurrentUser().catch(() => {}),
    15000,
  );
});
onUnmounted(() => {
  clearInterval(authorizationTimer);
  stopAuthorizationUpdates();
});
const activeGroup = computed(() =>
  navigation.value.find((group) => group.items.includes(view.value)),
);
const permissionStamp = computed(() =>
  JSON.stringify([
    [
      "devices",
      "monitoring",
      "records",
      "jobs",
      "aiRecords",
      "aiSearch",
      "alarms",
      "subscriptions",
      "tracks",
      "map",
    ].includes(view.value)
      ? authorizationRevision.value
      : 0,
    currentUser.value?.roleId,
    currentUser.value?.scopeMode,
    currentUser.value?.authorizationVersion,
    currentUser.value?.permissions,
  ]),
);
const menuResults = computed(() =>
  navigation.value
    .flatMap((group) =>
      group.items.map((key) => ({
        key,
        label: labels[key],
        group: group.title,
      })),
    )
    .filter((item) =>
      (item.label + item.group)
        .toLowerCase()
        .includes(menuQuery.value.trim().toLowerCase()),
    ),
);
function toggleGroup(title: string) {
  if (collapsed.value) {
    collapsed.value = false;
    expandedGroup.value = title;
  } else expandedGroup.value = expandedGroup.value === title ? null : title;
}
const viewStorageKey = (userId: string) => `ls-aegis:last-view:${userId}`;
const tabsStorageKey = (userId: string) => `ls-aegis:opened-pages:${userId}`;
function saveNavigation() {
  const user = currentUser.value;
  if (
    !user ||
    !ready.value ||
    !navigation.value.some((g) => g.items.includes(view.value))
  )
    return;
  try {
    sessionStorage.setItem(viewStorageKey(user.id), view.value);
    sessionStorage.setItem(
      tabsStorageKey(user.id),
      JSON.stringify(openedPages.value),
    );
  } catch {
    // The address still retains the current page when storage is unavailable.
  }
  try {
    const url = new URL(window.location.href);
    url.hash = new URLSearchParams({ page: view.value }).toString();
    window.history.replaceState(window.history.state, "", url);
  } catch {
    // Storage remains a fallback when history updates are unavailable.
  }
}
watch([ready, () => [...openedPages.value]], saveNavigation, { flush: "sync" });
watch(
  view,
  (key) => {
    if (!navigation.value.some((group) => group.items.includes(key))) return;
    expandedGroup.value = activeGroup.value?.title || null;
    if (!openedPages.value.includes(key)) openedPages.value.push(key);
    saveNavigation();
    void nextTick(() =>
      pageTabs.value
        ?.querySelector('[aria-current="page"]')
        ?.scrollIntoView({ block: "nearest", inline: "nearest" }),
    );
  },
  { flush: "sync" },
);
watch(
  () => currentUser.value?.id,
  (_, previousUserId) => {
    profileDialog.value?.close();
    clearProfileForm();
    if (previousUserId) {
      try {
        sessionStorage.removeItem(viewStorageKey(previousUserId));
        sessionStorage.removeItem(tabsStorageKey(previousUserId));
      } catch {
        // The session still resets when browser storage is unavailable.
      }
    }
    view.value = navigation.value[0]?.items[0] || "";
    if (navigation.value.some((g) => g.items.includes("devices")))
      view.value = "devices";
    openedPages.value = view.value ? [view.value] : [];
    expandedGroup.value = "基础管理";
    menuQuery.value = "";
    menuSearch.value?.close();
  },
);
function closePage(key: string) {
  if (openedPages.value.length <= 1) return;
  const index = openedPages.value.indexOf(key);
  if (index < 0) return;
  openedPages.value = openedPages.value.filter((page) => page !== key);
  if (view.value === key)
    navigate(openedPages.value[Math.min(index, openedPages.value.length - 1)]!);
}
function openMenuSearch() {
  if (!currentUser.value || document.querySelector("dialog[open]")) return;
  menuQuery.value = "";
  menuSearch.value?.showModal();
}
function selectMenuResult(key: string) {
  menuSearch.value?.close();
  navigate(key);
}
function handleMenuShortcut(event: KeyboardEvent) {
  if (
    (event.ctrlKey || event.metaKey) &&
    !event.altKey &&
    event.key.toLowerCase() === "k" &&
    currentUser.value &&
    !document.querySelector("dialog[open]")
  ) {
    event.preventDefault();
    openMenuSearch();
  }
}
onMounted(() => window.addEventListener("keydown", handleMenuShortcut));
onUnmounted(() => window.removeEventListener("keydown", handleMenuShortcut));
function migrateAiPage(key: string | null) {
  return key === "aiAnalysis" ? "aiSearch" : key;
}
function navigate(key: string) {
  key = migrateAiPage(key)!;
  if (!navigation.value.some((group) => group.items.includes(key))) return;
  view.value = key;
  closeNavigation();
}
const initialDevice = ref("");
function track(id: string) {
  initialDevice.value = id;
  view.value = "tracks";
}
const initialChannel = ref("");
function preview(channelId: string) {
  initialChannel.value = channelId;
  view.value = "monitoring";
}
onMounted(async () => {
  try {
    setup.value = (await api<{ required: boolean }>("/setup")).required;
    if (!setup.value) {
      const session = await api<{ user: User; csrf: string }>("/me");
      setSession(session);
      await nextTick();
      const allowed = navigation.value.flatMap((group) => group.items);
      const addressedView = migrateAiPage(
        new URLSearchParams(window.location.hash.slice(1)).get("page"),
      );
      let savedView: string | null = null;
      let savedTabs: string[] = [];
      try {
        savedView = migrateAiPage(
          sessionStorage.getItem(viewStorageKey(session.user.id)),
        );
        const storedTabs: unknown = JSON.parse(
          sessionStorage.getItem(tabsStorageKey(session.user.id)) || "null",
        );
        if (Array.isArray(storedTabs))
          savedTabs = [
            ...new Set(
              storedTabs
                .map((key) =>
                  typeof key === "string" ? migrateAiPage(key) : key,
                )
                .filter(
                  (key): key is string =>
                    typeof key === "string" && allowed.includes(key),
                ),
            ),
          ];
      } catch {
        // A validated page in the address does not depend on browser storage.
      }
      const target = [addressedView, savedView].find(
        (key) => key && allowed.includes(key),
      );
      if (target) navigate(target);
      openedPages.value = [
        ...new Set(
          [...savedTabs, view.value].filter((key) => allowed.includes(key)),
        ),
      ];
    }
  } catch (e) {
    if (messageOf(e) !== "请先登录") error.value = messageOf(e);
  } finally {
    ready.value = true;
  }
});
async function signIn() {
  busy.value = true;
  error.value = "";
  try {
    const data = { username: username.value, password: password.value };
    if (setup.value) {
      await api("/setup", "POST", data);
      setup.value = false;
    }
    setSession(await api("/auth/login", "POST", data));
    password.value = "";
    view.value = navigation.value.some((g) => g.items.includes("devices"))
      ? "devices"
      : navigation.value[0]?.items[0] || "";
    navigationOpen.value = false;
  } catch (e) {
    error.value = messageOf(e);
  } finally {
    busy.value = false;
  }
}
async function signOut() {
  try {
    await logout();
  } catch (e) {
    error.value = messageOf(e);
  }
}
</script>
<template>
  <div v-if="!ready" class="auth-loading" role="status">
    <BrandMark /><strong>雷铄御警</strong><span>正在连接 Ls-Aegis…</span>
  </div>
  <div v-else-if="!currentUser" id="auth" class="auth">
    <div class="auth-intro">
      <div class="auth-brand">
        <BrandMark />
        <div><strong>雷铄御警</strong><span>Ls-Aegis</span></div>
      </div>
      <div class="auth-hero">
        <span class="auth-eyebrow">LS-AEGIS VIDEO MANAGEMENT</span>
        <h2>视频资源，一站统管<br /><span>守护每一处现场</span></h2>
        <p>
          连接视频资源，协同日常管理。<br />让设备接入、视频调阅与告警处置更加有序。
        </p>
        <div class="auth-illustration" aria-hidden="true">
          <div class="orbit orbit-outer"></div>
          <div class="orbit orbit-inner"></div>
          <svg class="orbit-lines" viewBox="0 0 440 280">
            <path
              d="M110 70 220 140 340 60M220 140l100 85M220 140 85 220"
              fill="none"
              stroke="#b5caff"
              stroke-width="1.5"
              stroke-dasharray="5 6"
            />
          </svg>
          <div class="hero-shield"><BrandMark /></div>
          <div class="hero-node node-camera">
            <AppIcon name="devices" :size="28" />
          </div>
          <div class="hero-node node-map">
            <AppIcon name="pin" :size="27" />
          </div>
          <div class="hero-node node-record">
            <AppIcon name="records" :size="26" />
          </div>
          <div class="hero-node node-alarm">
            <AppIcon name="subscriptions" :size="25" />
          </div>
        </div>
        <div class="auth-features">
          <span>国标接入</span><span>视频调阅</span><span>告警协同</span>
        </div>
      </div>
      <div class="auth-intro-footer">GB28181 视频综合管理平台</div>
    </div>
    <div class="auth-form-area">
      <form class="auth-card" @submit.prevent="signIn">
        <div class="auth-mobile-brand">
          <BrandMark /><span>雷铄御警 <small>Ls-Aegis</small></span>
        </div>
        <span class="login-eyebrow">欢迎使用 Ls-Aegis</span>
        <h1>{{ setup ? "初始化管理员" : "欢迎登录" }}</h1>
        <p>
          {{
            setup
              ? "首次使用，请创建管理员。密码至少12位。"
              : "登录雷铄御警，进入视频管理工作台"
          }}
        </p>
        <label
          >账号<span class="input-affix"
            ><AppIcon name="user" /><input
              v-model="username"
              placeholder="请输入账号"
              required
              pattern="[a-zA-Z0-9_\-]{3,32}"
              minlength="3"
              maxlength="32"
              title="3～32位字母、数字、下划线或连字符"
              autocomplete="username" /></span></label
        ><label
          >密码<span class="input-affix"
            ><AppIcon name="lock" /><input
              v-model="password"
              placeholder="请输入密码"
              type="password"
              required
              :minlength="setup ? 12 : 1"
              maxlength="128"
              :autocomplete="
                setup ? 'new-password' : 'current-password'
              " /></span
        ></label>
        <p role="alert" class="error">{{ error || authNotice }}</p>
        <button class="login-submit" :disabled="busy">
          {{ busy ? "处理中…" : setup ? "创建管理员并登录" : "登录" }}
        </button>
        <div class="login-security">
          <AppIcon name="lock" :size="14" />仅限授权用户访问，请妥善保管账号信息
        </div>
      </form>
      <div class="auth-form-footer">雷铄御警 · Ls-Aegis</div>
    </div>
  </div>
  <div
    v-else
    id="workspace"
    :class="{ 'nav-collapsed': collapsed, 'nav-open': navigationOpen }"
    @keydown.esc="closeNavigation"
  >
    <button
      v-if="navigationOpen"
      class="nav-backdrop"
      aria-label="关闭导航"
      @click="closeNavigation"
    ></button>
    <aside ref="sidebar" id="primary-navigation">
      <div class="brand">
        <BrandMark />
        <div>
          <h2>雷铄御警</h2>
          <small>Ls-Aegis</small>
        </div>
      </div>
      <nav aria-label="主导航">
        <div v-for="group in navigation" :key="group.title" class="nav-group">
          <button
            class="nav-parent"
            :class="{ 'is-current': activeGroup?.title === group.title }"
            :aria-label="group.title"
            :title="group.title"
            :aria-expanded="!collapsed && expandedGroup === group.title"
            :aria-controls="'nav-group-' + group.icon"
            @click="toggleGroup(group.title)"
          >
            <AppIcon :name="group.icon" /><span>{{ group.title }}</span>
            <AppIcon
              name="chevron"
              :size="14"
              class="nav-chevron"
              :class="{ 'is-open': expandedGroup === group.title }"
            />
          </button>
          <div
            class="nav-children"
            :id="'nav-group-' + group.icon"
            v-show="expandedGroup === group.title"
          >
            <button
              v-for="key in group.items"
              :key="key"
              class="nav-button"
              :class="{ active: view === key }"
              :aria-current="view === key ? 'page' : undefined"
              :aria-label="labels[key]"
              :title="labels[key]"
              @click="navigate(key)"
            >
              <AppIcon :name="key" /><span>{{ labels[key] }}</span>
            </button>
          </div>
        </div>
      </nav>
      <footer>
        <span class="footer-protocol">GB28181 视频管理</span><span>v0.7.1</span>
      </footer>
    </aside>
    <main>
      <header class="workspace-header">
        <div class="header-title">
          <button
            class="icon-button desktop-menu-toggle"
            :aria-label="collapsed ? '展开导航' : '收起导航'"
            :aria-expanded="!collapsed"
            aria-controls="primary-navigation"
            @click="collapsed = !collapsed"
          >
            <AppIcon name="fold" />
          </button>
          <button
            class="icon-button mobile-menu-toggle"
            ref="mobileMenuButton"
            :aria-label="navigationOpen ? '关闭导航' : '打开导航'"
            :aria-expanded="navigationOpen"
            aria-controls="primary-navigation"
            @click="toggleMobileNavigation"
          >
            <AppIcon name="menu" />
          </button>
          <template v-if="layout.breadcrumbs">
            <span class="header-product">雷铄御警</span
            ><span class="header-divider">/</span>
            <span class="breadcrumb breadcrumb-group">{{
              activeGroup?.title
            }}</span
            ><span class="header-divider">/</span>
            <span class="breadcrumb">{{ labels[view] }}</span>
          </template>
        </div>
        <div class="header-account">
          <button
            class="nav-search-button"
            aria-label="搜索菜单"
            title="搜索菜单（Ctrl+K）"
            @click="openMenuSearch"
          >
            <AppIcon name="search" :size="16" /><span>搜索菜单</span
            ><kbd>Ctrl K</kbd>
          </button>
          <button
            class="icon-button header-tool"
            aria-label="项目配置"
            title="项目配置"
            @click="appearanceDrawer?.showModal()"
          >
            <AppIcon name="config" :size="17" />
          </button>
          <button
            v-if="navigation.some((group) => group.items.includes('alarms'))"
            class="icon-button header-tool"
            title="告警消息"
            aria-label="告警消息"
            @click="navigate('alarms')"
          >
            <AppIcon name="subscriptions" :size="17" />
          </button>
          <button
            class="icon-button header-tool"
            aria-label="切换全屏"
            :aria-pressed="workspaceFullscreen"
            :title="workspaceFullscreen ? '退出全屏' : '进入全屏'"
            @click="toggleWorkspaceFullscreen"
          >
            <AppIcon
              :name="workspaceFullscreen ? 'restore' : 'fullscreen'"
              :size="17"
            />
          </button>
          <p
            v-if="fullscreenNotice"
            class="header-fullscreen-notice"
            role="status"
          >
            {{ fullscreenNotice }}
          </p>
          <button
            class="icon-button header-tool"
            aria-label="深色侧栏"
            title="深色侧栏"
            :aria-pressed="layout.darkSidebar"
            @click="layout.darkSidebar = !layout.darkSidebar"
          >
            <AppIcon name="moon" :size="17" />
          </button>
          <button
            class="account-trigger"
            popovertarget="account-panel"
            :aria-label="'账号菜单：' + currentUser.username"
          >
            <span class="user-avatar"><AppIcon name="user" :size="16" /></span>
            <span class="account-name">{{
              currentUser.displayName || currentUser.username
            }}</span>
            <AppIcon name="chevron" :size="12" />
          </button>
          <dialog
            ref="appearanceDrawer"
            class="appearance-drawer"
            aria-labelledby="appearance-title"
          >
            <div class="appearance-drawer-heading">
              <h2 id="appearance-title">项目配置</h2>
              <button
                class="icon-button"
                aria-label="关闭配置"
                @click="appearanceDrawer?.close()"
              >
                <AppIcon name="close" />
              </button>
            </div>
            <div class="appearance-drawer-body">
              <h3>整体风格</h3>
              <div class="appearance-style-options">
                <button
                  class="secondary"
                  :aria-pressed="!layout.darkSidebar"
                  @click="layout.darkSidebar = false"
                >
                  浅色侧栏
                </button>
                <button
                  class="secondary"
                  :aria-pressed="layout.darkSidebar"
                  @click="layout.darkSidebar = true"
                >
                  深色侧栏
                </button>
              </div>
              <h3>主题色</h3>
              <div class="appearance-swatches">
                <button
                  v-for="theme in themes"
                  :key="theme.id"
                  type="button"
                  class="theme-swatch"
                  :data-theme="theme.id"
                  :aria-label="theme.label"
                  :title="theme.label"
                  :aria-pressed="appearance === theme.id"
                  @click="appearance = theme.id"
                >
                  <span
                    v-if="appearance === theme.id"
                    class="theme-check"
                    aria-hidden="true"
                    >✓</span
                  >
                </button>
              </div>
              <label class="appearance-row"
                >面包屑<input
                  type="checkbox"
                  role="switch"
                  v-model="layout.breadcrumbs"
              /></label>
              <label class="appearance-row"
                >表格边框<input
                  type="checkbox"
                  role="switch"
                  v-model="layout.tableBorders"
              /></label>
              <label class="appearance-row"
                >表格尺寸<select v-model="layout.compactTable">
                  <option :value="false">标准</option>
                  <option :value="true">紧凑</option>
                </select></label
              >
              <label class="appearance-row"
                >多标签<input
                  type="checkbox"
                  role="switch"
                  v-model="layout.tabs"
              /></label>
              <label class="appearance-row"
                >折叠菜单<input
                  type="checkbox"
                  role="switch"
                  v-model="collapsed"
              /></label>
              <p class="appearance-note">外观偏好自动保存在当前浏览器。</p>
              <button
                type="button"
                class="secondary"
                @click="
                  resetAppearance();
                  collapsed = false;
                "
              >
                恢复默认外观
              </button>
            </div>
          </dialog>
          <div
            id="account-panel"
            ref="accountPanel"
            class="header-popover"
            popover
          >
            <div class="header-popover-title account-summary">
              <strong>{{
                currentUser.displayName || currentUser.username
              }}</strong>
              <small
                >{{ currentUser.username }} ·
                {{ roleLabel(currentUser) }}</small
              >
            </div>
            <button
              type="button"
              class="header-popover-action"
              @click="openProfile"
            >
              <AppIcon name="user" :size="16" />个人中心
            </button>
            <button
              v-if="navigation.some((group) => group.items.includes('alarms'))"
              type="button"
              class="header-popover-action"
              @click="
                accountPanel?.hidePopover();
                navigate('alarms');
              "
            >
              <AppIcon name="subscriptions" :size="16" />告警消息
            </button>
            <button
              type="button"
              class="header-popover-action"
              @click="signOut"
            >
              <AppIcon name="logout" :size="16" />退出登录
            </button>
          </div>
          <dialog
            ref="profileDialog"
            class="business-dialog profile-dialog"
            aria-labelledby="profile-title"
            @close="clearProfileForm"
            @cancel="profileLocked && $event.preventDefault()"
          >
            <div class="business-dialog-heading">
              <h2 id="profile-title">个人中心</h2>
              <button
                class="icon-button"
                aria-label="关闭个人中心"
                :disabled="profileLocked"
                @click="profileDialog?.close()"
              >
                <AppIcon name="close" />
              </button>
            </div>
            <dl class="profile-summary">
              <dt>当前账号</dt>
              <dd>{{ currentUser.username }}</dd>
              <dt>账号角色</dt>
              <dd>
                {{ roleLabel(currentUser) }}
              </dd>
            </dl>
            <div class="profile-tabs" role="group" aria-label="个人中心栏目">
              <button
                type="button"
                :aria-pressed="profileTab === 'details'"
                :disabled="profileLocked"
                @click="profileTab = 'details'"
              >
                基本资料
              </button>
              <button
                type="button"
                :aria-pressed="profileTab === 'security'"
                :disabled="profileLocked"
                @click="profileTab = 'security'"
              >
                账号安全
              </button>
            </div>
            <PersonalDetails
              v-if="profileOpen"
              v-show="profileTab === 'details'"
              @busy="detailsBusy = $event"
            />
            <form
              v-if="profileTab === 'security'"
              class="profile-form"
              @submit.prevent="saveOwnPassword"
            >
              <h3>修改密码</h3>
              <p>新密码须为 12～128 个字符。保存后，请用新密码重新登录。</p>
              <label
                >当前密码<input
                  v-model="currentPassword"
                  type="password"
                  autocomplete="current-password"
                  required
                  maxlength="128"
                  :disabled="profileBusy"
              /></label>
              <label
                >新密码<input
                  v-model="newPassword"
                  type="password"
                  autocomplete="new-password"
                  required
                  minlength="12"
                  maxlength="128"
                  :disabled="profileBusy"
              /></label>
              <label
                >确认新密码<input
                  v-model="confirmPassword"
                  type="password"
                  autocomplete="new-password"
                  required
                  minlength="12"
                  maxlength="128"
                  :disabled="profileBusy"
              /></label>
              <p v-if="profileError" class="error" role="alert">
                {{ profileError }}
              </p>
              <div class="dialog-actions">
                <button
                  type="button"
                  class="secondary"
                  :disabled="profileBusy"
                  @click="profileDialog?.close()"
                >
                  取消
                </button>
                <button type="submit" :disabled="profileBusy">
                  {{ profileBusy ? "正在保存…" : "更新密码" }}
                </button>
              </div>
            </form>
          </dialog>
        </div>
      </header>
      <nav
        v-show="layout.tabs"
        ref="pageTabs"
        class="page-tabs"
        aria-label="已打开页面"
      >
        <div
          v-for="key in openedPages"
          :key="key"
          class="page-tab"
          :class="{ 'is-active': view === key }"
        >
          <button
            :aria-label="'切换到' + labels[key]"
            :aria-current="view === key ? 'page' : undefined"
            @click="navigate(key)"
          >
            {{ labels[key] }}
          </button>
          <button
            v-if="openedPages.length > 1"
            class="page-tab-close"
            :aria-label="'关闭' + labels[key] + '页签'"
            @click="closePage(key)"
          >
            <AppIcon name="close" :size="12" />
          </button>
        </div>
      </nav>
      <p v-if="error" role="alert" class="error">{{ error }}</p>
      <section v-if="!view" class="business-page">
        <div class="panel empty-state">
          <h2>暂无可用功能</h2>
          <p>请联系系统管理员配置角色和设备范围。仍可在右上角维护个人资料。</p>
        </div>
      </section>
      <Devices
        :key="permissionStamp"
        v-else-if="view === 'devices'"
        @preview="preview"
      /><Monitoring
        :key="permissionStamp"
        v-else-if="view === 'monitoring'"
        :initial-channel="initialChannel"
      /><Records
        :key="permissionStamp"
        v-else-if="view === 'records'"
        @downloads="view = 'jobs'"
      /><RecordingCenter
        v-else-if="view === 'jobs' || view === 'plans'"
        :key="view + permissionStamp"
        :section="view"
      /><AiAnalyses
        v-else-if="view === 'aiRecords'"
        :key="permissionStamp"
        records-only
        @navigate="view = $event"
      /><AiWorkspace
        v-else-if="view === 'aiSearch'"
        :key="permissionStamp"
        @navigate="view = $event"
      /><AiModels v-else-if="view === 'aiModels'" /><Subscriptions
        :key="permissionStamp"
        v-else-if="view === 'subscriptions'"
      /><Trajectories
        :key="permissionStamp"
        v-else-if="view === 'tracks'"
        :initial-device="initialDevice"
      /><Alarms
        :key="permissionStamp"
        v-else-if="view === 'alarms'"
      /><DeviceMap
        :key="permissionStamp"
        v-else-if="view === 'map'"
        @track="track"
        @preview="preview"
      /><Groups :key="permissionStamp" v-else-if="view === 'groups'" /><Cascade
        :key="permissionStamp"
        v-else-if="view === 'cascade'"
      /><Administration v-else :key="view + permissionStamp" :view="view" />
    </main>
    <dialog
      ref="menuSearch"
      class="menu-search-dialog"
      aria-labelledby="menu-search-heading"
    >
      <div class="menu-search-heading">
        <h2 id="menu-search-heading">菜单快速定位</h2>
        <button
          class="icon-button"
          aria-label="关闭菜单搜索"
          @click="menuSearch?.close()"
        >
          <AppIcon name="close" />
        </button>
      </div>
      <label class="menu-search-input"
        ><AppIcon name="search" /><input
          v-model="menuQuery"
          autofocus
          placeholder="输入功能或分组名称，例如：录像"
          aria-label="搜索功能菜单"
          autocomplete="off"
      /></label>
      <div class="menu-search-results">
        <button
          v-for="item in menuResults"
          :key="item.key"
          @click="selectMenuResult(item.key)"
        >
          <AppIcon :name="item.key" /><span
            >{{ item.label }}<small>{{ item.group }}</small></span
          ><AppIcon name="arrow" :size="15" />
        </button>
        <p v-if="!menuResults.length" class="menu-search-empty">
          没有匹配的菜单，请更换关键词。
        </p>
      </div>
      <p class="menu-search-note">仅显示当前账号可访问的功能菜单 · Esc 关闭</p>
    </dialog>
  </div>
</template>
