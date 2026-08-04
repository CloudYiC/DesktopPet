import {
  ChangeEvent,
  FormEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { postHostMessage, subscribeHost } from '../bridge/hostBridge';
import { AppSidebar } from '../navigation/AppSidebar';
import type { DashboardView } from '../navigation/types';
import { AccountView, PluginStoreView } from '../shell/ShellViews';
import { Toolbox } from '../toolbox/Toolbox';
import { categoryById, type ToolCategoryId } from '../toolbox/catalog';
import type {
  AppState,
  CharacterLayout,
  CharacterProfile,
  HostMessage,
  Reminder,
  ReminderPriority,
  RepeatRule,
  WorkspaceTextSize,
  WorkspaceTheme,
} from '../types';
import styles from './Dashboard.module.scss';

type PetAction = 'wave' | 'hop' | 'walkRight' | 'sleepy' | 'petted';
type PetPreviewAction = PetAction | 'idle';
type AllReminderFilter = 'all' | 'overdue' | 'today' | 'upcoming' | 'repeating' | 'urgent';

const builtInCharacter: CharacterProfile = {
  id: 'builtin',
  name: '经典小鼠',
  imageUrl: '/assets/milo-sprite.png',
  layout: 'sheet',
  builtIn: true,
};

const initialState: AppState = {
  reminders: [],
  now: Date.now(),
  petName: '可爱依依',
  soundEnabled: true,
  speechEnabled: false,
  autoHideEnabled: true,
  autoHideMinutes: 10,
  characters: [builtInCharacter],
  activeCharacterId: 'builtin',
  workspaceTheme: 'warm',
  workspaceTextSize: 'comfortable',
  openLastView: true,
  lastDashboardView: 'today',
  lastToolCategory: '',
};

const repeatLabels: Record<RepeatRule, string> = {
  none: '仅一次',
  daily: '每天',
  weekdays: '工作日',
  weekly: '每周',
};

const priorityLabels: Record<ReminderPriority, string> = {
  normal: '日常',
  important: '重要',
  urgent: '紧急',
};

const priorityClassNames: Record<ReminderPriority, string> = {
  normal: styles.priorityNormal,
  important: styles.priorityImportant,
  urgent: styles.priorityUrgent,
};

const statusActionClassNames: Record<PetPreviewAction, string> = {
  idle: styles.statusIdle,
  wave: styles.statusWaveAction,
  hop: styles.statusHopAction,
  walkRight: styles.statusWalkAction,
  sleepy: styles.statusSleepAction,
  petted: styles.statusPettedAction,
};

const statusActionGlyphs: Record<PetAction, string> = {
  wave: '♥',
  hop: '✦',
  walkRight: '➜',
  sleepy: 'zZ',
  petted: '♡',
};

const autoHideMinuteOptions = [1, 2, 5, 10, 20, 30, 60];

/** Converts epoch milliseconds to the local format expected by datetime-local. */
function toDateTimeInput(timestamp: number) {
  const date = new Date(timestamp);
  const timezoneOffset = date.getTimezoneOffset() * 60_000;
  return new Date(timestamp - timezoneOffset).toISOString().slice(0, 16);
}

function formatDate(timestamp: number) {
  const date = new Date(timestamp);
  const today = new Date();
  const sameDay = date.toDateString() === today.toDateString();
  return new Intl.DateTimeFormat('zh-CN', {
    month: sameDay ? undefined : 'short',
    day: sameDay ? undefined : 'numeric',
    weekday: sameDay ? undefined : 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

function relativeTime(timestamp: number) {
  const difference = timestamp - Date.now();
  const minutes = Math.round(difference / 60_000);
  if (minutes <= 0) return '现在';
  if (minutes < 60) return `${minutes} 分钟后`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} 小时后`;
  return `${Math.round(hours / 24)} 天后`;
}

function greetingForHour(hour: number) {
  if (hour < 6) return '夜深了';
  if (hour < 11) return '早上好';
  if (hour < 14) return '中午好';
  if (hour < 19) return '下午好';
  return '晚上好';
}

function readImageAsDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener('load', () => {
      if (typeof reader.result === 'string') {
        resolve(reader.result);
      } else {
        reject(new Error('图片读取失败。'));
      }
    });
    reader.addEventListener('error', () => reject(new Error('图片读取失败。')));
    reader.readAsDataURL(file);
  });
}

export function Dashboard() {
  const [state, setState] = useState<AppState>(initialState);
  const [activeView, setActiveView] = useState<DashboardView>('today');
  const [activeToolCategory, setActiveToolCategory] = useState<ToolCategoryId | null>(null);
  const [title, setTitle] = useState('');
  const [dueAt, setDueAt] = useState(toDateTimeInput(Date.now() + 30 * 60_000));
  const [repeatRule, setRepeatRule] = useState<RepeatRule>('none');
  const [priority, setPriority] = useState<ReminderPriority>('normal');
  const [error, setError] = useState('');
  const [allReminderQuery, setAllReminderQuery] = useState('');
  const [allReminderFilter, setAllReminderFilter] = useState<AllReminderFilter>('all');
  const [lastAction, setLastAction] = useState('正在陪你安静待机');
  const [draftName, setDraftName] = useState(initialState.petName);
  const [settingsSaved, setSettingsSaved] = useState('');
  const [characterName, setCharacterName] = useState('新朋友');
  const [characterLayout, setCharacterLayout] = useState<CharacterLayout>('single');
  const [isUploadingCharacter, setIsUploadingCharacter] = useState(false);
  const [celebrating, setCelebrating] = useState(false);
  const [previewAction, setPreviewAction] = useState<PetPreviewAction>('idle');
  const [actionSequence, setActionSequence] = useState(0);
  const celebrationTimer = useRef<number>();
  const actionPreviewTimer = useRef<number>();
  const restoredNavigation = useRef(false);

  useEffect(() => {
    // Native state snapshots are authoritative; local state only drives form UI.
    const unsubscribe = subscribeHost((message: HostMessage) => {
      if (message.type === 'state.sync') {
        const incoming = {
          ...initialState,
          ...(message.payload as Partial<AppState>),
        };
        setState(incoming);
        if (!restoredNavigation.current) {
          restoredNavigation.current = true;
          if (incoming.openLastView) {
            const rememberedView = incoming.lastDashboardView as DashboardView;
            const validViews: DashboardView[] = [
              'toolbox', 'today', 'all', 'status', 'settings', 'marketplace', 'account',
            ];
            if (validViews.includes(rememberedView)) setActiveView(rememberedView);
            if (incoming.lastToolCategory && categoryById(incoming.lastToolCategory as ToolCategoryId)) {
              setActiveToolCategory(incoming.lastToolCategory as ToolCategoryId);
            }
          }
        }
        setError('');
      }
      if (message.type === 'app.error') {
        setError((message.payload as { message: string }).message);
      }
      if (message.type === 'reminder.completed') {
        setCelebrating(true);
        window.clearTimeout(celebrationTimer.current);
        celebrationTimer.current = window.setTimeout(() => setCelebrating(false), 1800);
      }
    });
    postHostMessage('app.ready');
    return () => {
      unsubscribe();
      window.clearTimeout(celebrationTimer.current);
      window.clearTimeout(actionPreviewTimer.current);
    };
  }, []);

  useEffect(() => {
    setDraftName(state.petName);
  }, [state.petName]);

  useEffect(() => {
    document.documentElement.dataset.workspaceTheme = state.workspaceTheme;
    document.documentElement.dataset.workspaceTextSize = state.workspaceTextSize;
  }, [state.workspaceTextSize, state.workspaceTheme]);

  useEffect(() => {
    if (!restoredNavigation.current) return;
    postHostMessage('workspace.navigation.update', {
      view: activeView,
      category: activeToolCategory ?? '',
    });
  }, [activeToolCategory, activeView]);

  const reminders = useMemo(
    () => [...state.reminders].sort((left, right) => left.dueAt - right.dueAt),
    [state.reminders],
  );
  const todayReminders = useMemo(
    () => reminders.filter(
      (reminder) => new Date(reminder.dueAt).toDateString() === new Date().toDateString(),
    ),
    [reminders],
  );
  const allReminderCounts = useMemo(() => {
    const now = Date.now();
    const todayEnd = new Date();
    todayEnd.setHours(23, 59, 59, 999);
    const weekEnd = todayEnd.getTime() + 6 * 24 * 60 * 60_000;
    return {
      overdue: reminders.filter((reminder) => reminder.dueAt < now).length,
      today: todayReminders.length,
      week: reminders.filter((reminder) => reminder.dueAt >= now && reminder.dueAt <= weekEnd).length,
      repeating: reminders.filter((reminder) => reminder.repeatRule !== 'none').length,
    };
  }, [reminders, todayReminders]);
  const filteredAllReminders = useMemo(() => {
    const query = allReminderQuery.trim().toLocaleLowerCase('zh-CN');
    const now = Date.now();
    const today = new Date().toDateString();
    return reminders.filter((reminder) => {
      if (query && !reminder.title.toLocaleLowerCase('zh-CN').includes(query)) return false;
      if (allReminderFilter === 'overdue') return reminder.dueAt < now;
      if (allReminderFilter === 'today') return new Date(reminder.dueAt).toDateString() === today;
      if (allReminderFilter === 'upcoming') return reminder.dueAt >= now;
      if (allReminderFilter === 'repeating') return reminder.repeatRule !== 'none';
      if (allReminderFilter === 'urgent') return reminder.priority === 'urgent';
      return true;
    });
  }, [allReminderFilter, allReminderQuery, reminders]);
  const visibleReminders = activeView === 'all' ? filteredAllReminders : todayReminders;
  const nextReminder = visibleReminders[0] ?? null;
  const repeatingCount = reminders.filter((reminder) => reminder.repeatRule !== 'none').length;
  const reminderGroups = useMemo(() => {
    if (activeView !== 'all') return [{ id: 'today', label: '今天', items: visibleReminders }];
    const now = Date.now();
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = today.getTime() + 24 * 60 * 60_000;
    const dayAfterTomorrow = tomorrow + 24 * 60 * 60_000;
    const weekEnd = today.getTime() + 7 * 24 * 60 * 60_000;
    const buckets = [
      { id: 'overdue', label: '已经超时', items: [] as Reminder[] },
      { id: 'today', label: '今天', items: [] as Reminder[] },
      { id: 'tomorrow', label: '明天', items: [] as Reminder[] },
      { id: 'week', label: '接下来 7 天', items: [] as Reminder[] },
      { id: 'later', label: '以后', items: [] as Reminder[] },
    ];
    visibleReminders.forEach((reminder) => {
      if (reminder.dueAt < now) buckets[0].items.push(reminder);
      else if (reminder.dueAt < tomorrow) buckets[1].items.push(reminder);
      else if (reminder.dueAt < dayAfterTomorrow) buckets[2].items.push(reminder);
      else if (reminder.dueAt < weekEnd) buckets[3].items.push(reminder);
      else buckets[4].items.push(reminder);
    });
    return buckets.filter((bucket) => bucket.items.length > 0);
  }, [activeView, visibleReminders]);
  const hour = new Date().getHours();
  const petMood = hour >= 23 || hour < 7 ? '有一点困啦' : '精神满满';
  const characters = state.characters?.length ? state.characters : [builtInCharacter];
  const activeCharacter = characters.find(
    (character) => character.id === state.activeCharacterId,
  ) ?? characters[0];
  const activeCategory = categoryById(activeToolCategory);
  const characterImageStyle = {
    // Encode the URL as a CSS string so paths with quotes remain valid.
    backgroundImage: `url(${JSON.stringify(activeCharacter.imageUrl)})`,
  };

  const submitReminder = (event: FormEvent) => {
    event.preventDefault();
    const timestamp = new Date(dueAt).getTime();
    if (!title.trim() || Number.isNaN(timestamp)) {
      setError('请写下事项，并选择提醒时间。');
      return;
    }
    postHostMessage('reminder.create', {
      title: title.trim(),
      dueAt: timestamp,
      repeatRule,
      priority,
    });
    setTitle('');
    setDueAt(toDateTimeInput(Date.now() + 30 * 60_000));
    setRepeatRule('none');
    setPriority('normal');
  };

  const createDemoReminder = () => {
    postHostMessage('reminder.create', {
      title: '站起来活动一下',
      dueAt: Date.now() + 10_000,
      repeatRule: 'none',
      priority: 'urgent',
    });
  };

  const complete = (reminder: Reminder) => {
    postHostMessage('reminder.complete', { id: reminder.id });
  };

  const askYiyiTo = (action: PetAction, description: string) => {
    // The native host broadcasts the action to the detached pet WebView while
    // this window runs a matching preview animation.
    postHostMessage('pet.action', { action });
    setLastAction(description);
    setPreviewAction(action);
    setActionSequence((sequence) => sequence + 1);
    window.clearTimeout(actionPreviewTimer.current);
    actionPreviewTimer.current = window.setTimeout(
      () => setPreviewAction('idle'),
      action === 'sleepy' ? 3_600 : 2_400,
    );
  };

  const updateSettings = (patch: Partial<Pick<
    AppState,
    | 'petName'
    | 'soundEnabled'
    | 'speechEnabled'
    | 'autoHideEnabled'
    | 'autoHideMinutes'
    | 'workspaceTheme'
    | 'workspaceTextSize'
    | 'openLastView'
  >>) => {
    // Send a complete settings record so older native hosts never need to merge
    // a partially defined payload.
    postHostMessage('settings.update', {
      petName: patch.petName ?? state.petName,
      soundEnabled: patch.soundEnabled ?? state.soundEnabled,
      speechEnabled: patch.speechEnabled ?? state.speechEnabled,
      autoHideEnabled: patch.autoHideEnabled ?? state.autoHideEnabled,
      autoHideMinutes: patch.autoHideMinutes ?? state.autoHideMinutes,
      workspaceTheme: patch.workspaceTheme ?? state.workspaceTheme,
      workspaceTextSize: patch.workspaceTextSize ?? state.workspaceTextSize,
      openLastView: patch.openLastView ?? state.openLastView,
    });
    setSettingsSaved('设置已保存');
    window.setTimeout(() => setSettingsSaved(''), 1600);
  };

  const savePetName = (event: FormEvent) => {
    event.preventDefault();
    const nextName = draftName.trim();
    if (!nextName) {
      setError('请先给小助手取一个名字。');
      return;
    }
    updateSettings({ petName: nextName });
  };

  const uploadCharacter = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (!['image/png', 'image/webp'].includes(file.type)) {
      setError('角色图片只支持 PNG 或 WebP。');
      return;
    }
    if (file.size > 4 * 1024 * 1024) {
      setError('角色图片不能超过 4 MB。');
      return;
    }
      const nextName = characterName.trim();
      if (!nextName) {
        setError('请先填写衣柜款式名称。');
      return;
    }

    try {
      setIsUploadingCharacter(true);
      setError('');
      const dataUrl = await readImageAsDataUrl(file);
      // C++ validates the decoded signature and persists the binary outside the UI.
      postHostMessage('character.upload', {
        name: nextName,
        layout: characterLayout,
        dataUrl,
      });
      setSettingsSaved(`“${nextName}”已加入衣柜并启用`);
      window.setTimeout(() => setSettingsSaved(''), 2200);
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : '角色上传失败。');
    } finally {
      setIsUploadingCharacter(false);
    }
  };

  const deleteCharacter = (character: CharacterProfile) => {
    if (character.builtIn) return;
    if (!window.confirm(`确定从衣柜删除“${character.name}”吗？`)) return;
    postHostMessage('character.delete', { id: character.id });
  };

  const viewHeading = activeView === 'toolbox'
      ? activeCategory?.label ?? 'CloudYi 开发工具箱'
    : activeView === 'marketplace'
      ? '让工具按需要来到你身边。'
    : activeView === 'account'
      ? '账户、外观与本机数据集中管理。'
    : activeView === 'all'
      ? '所有小事，都在这里。'
    : activeView === 'status'
      ? `${state.petName}，今天也在陪你。`
    : activeView === 'settings'
      ? '把陪伴方式调成你喜欢的样子。'
      : `${greetingForHour(hour)}，慢慢来就好。`;
  const viewDescription = activeView === 'toolbox'
    ? activeCategory?.description ?? '本地优先的常用开发工具，不离开桌面也能快速处理数据。'
    : activeView === 'marketplace'
      ? '查看已内置工具和后续将从 CloudYiCSC 迁移的插件。'
    : activeView === 'account'
      ? '主题、字号、启动页面和插件状态都可以在这里调整；云端接入前不会上传本地内容。'
    : activeView === 'all'
    ? '一次看看所有待办和重复提醒。'
    : activeView === 'status'
      ? `看看${state.petName}的状态，也可以叫她做个小动作。`
    : activeView === 'settings'
      ? '角色、名字、声音和自动收起都集中在这里。'
      : `${state.petName}会帮你看着时间，不让重要的小事溜走。`;
  const viewKicker = activeView === 'toolbox'
    ? 'CLOUDYI TOOLBOX'
    : activeView === 'marketplace'
      ? 'SIGNED EXTENSIONS'
      : activeView === 'account'
        ? 'CLOUDYI CENTER'
        : 'CUTE COMPANION ROUTINE';

  return (
    <div className={styles.appShell}>
      {celebrating && (
        <div className={styles.completionConfetti} aria-live="polite">
          <strong>完成得漂亮！</strong>
          {['✦', '●', '♥', '◆', '✦', '●', '♥', '◆', '✦', '●', '♥', '◆'].map((piece, index) => (
            <i key={`${piece}-${index}`}>{piece}</i>
          ))}
        </div>
      )}
      <AppSidebar
        activeView={activeView}
        activeCategory={activeToolCategory}
        petName={state.petName}
        petMood={petMood}
        petImageUrl={activeCharacter.imageUrl}
        petLayout={activeCharacter.layout}
        todayCount={todayReminders.length}
        reminderCount={reminders.length}
        onViewChange={setActiveView}
        onToolboxChange={(category) => {
          setActiveToolCategory(category);
          setActiveView('toolbox');
        }}
        onCreateDemoReminder={createDemoReminder}
      />

      <main className={styles.content}>
        <header className={styles.header}>
          <div>
            <span className={styles.kicker}>{viewKicker}</span>
            <h1>{viewHeading}</h1>
            <p>{viewDescription}</p>
          </div>
        </header>

        {error && activeView === 'settings' && (
          <div className={styles.errorMessage}>{error}</div>
        )}

        {activeView === 'toolbox' ? (
          <Toolbox
            category={activeToolCategory}
            onOpenCategory={(category) => setActiveToolCategory(category)}
          />
        ) : activeView === 'marketplace' ? (
          <PluginStoreView />
        ) : activeView === 'account' ? (
          <AccountView
            state={state}
            onPreferencesChange={(patch: {
              workspaceTheme?: WorkspaceTheme;
              workspaceTextSize?: WorkspaceTextSize;
              openLastView?: boolean;
            }) => updateSettings(patch)}
            onOpenPluginStore={() => setActiveView('marketplace')}
          />
        ) : activeView === 'status' || activeView === 'settings' ? (
          <section
            className={
              activeView === 'settings' ? styles.settingsView : styles.statusView
            }
          >
            {activeView === 'status' && (
              <>
            <article className={styles.statusHero}>
              <div
                className={`${styles.statusPortrait} ${
                  statusActionClassNames[previewAction]
                }`}
                aria-live="polite"
              >
                <div
                  key={`${activeCharacter.id}-${actionSequence}`}
                  className={`${styles.statusCharacter} ${
                    activeCharacter.layout === 'single' ? styles.singlePortrait : ''
                  }`}
                  style={characterImageStyle}
                />
                <span className={styles.statusHeart} aria-hidden="true">♥</span>
                {previewAction !== 'idle' && (
                  <span
                    key={`effect-${actionSequence}`}
                    className={styles.statusActionFx}
                    aria-hidden="true"
                  >
                    {statusActionGlyphs[previewAction]}
                  </span>
                )}
              </div>
              <div className={styles.statusCopy}>
                <span>{state.petName} IS HERE</span>
                <h2>{petMood}</h2>
                <p>{lastAction} · {hour >= 21 || hour < 7 ? '今晚戴着软绵绵的睡帽' : '白天别着一朵元气小花'}</p>
              </div>
              <i className={styles.onlinePulse} />
            </article>

            <div className={styles.statusStats}>
              <article><span>全部待办</span><strong>{reminders.length}</strong><small>项</small></article>
              <article><span>今天提醒</span><strong>{todayReminders.length}</strong><small>项</small></article>
              <article><span>重复提醒</span><strong>{repeatingCount}</strong><small>项</small></article>
            </div>

            <section className={styles.interactionPanel}>
              <div className={styles.sectionHeading}>
                <div><span>INTERACTIONS</span><h2>和{state.petName}互动</h2></div>
                <em>状态卡和桌面角色会同步响应</em>
              </div>
              <div className={styles.actionGrid}>
                <button
                  className={previewAction === 'wave' ? styles.actionButtonActive : ''}
                  type="button"
                  aria-pressed={previewAction === 'wave'}
                  onClick={() => askYiyiTo('wave', `${state.petName}刚刚开心地向你挥了挥手`)}
                >
                  <span>♥</span><strong>挥挥手</strong><small>飘出小爱心</small>
                </button>
                <button
                  className={previewAction === 'hop' ? styles.actionButtonActive : ''}
                  type="button"
                  aria-pressed={previewAction === 'hop'}
                  onClick={() => askYiyiTo('hop', `${state.petName}刚刚为你活力满满地跳了一下`)}
                >
                  <span>✦</span><strong>跳一下</strong><small>闪亮登场</small>
                </button>
                <button
                  className={previewAction === 'walkRight' ? styles.actionButtonActive : ''}
                  type="button"
                  aria-pressed={previewAction === 'walkRight'}
                  onClick={() => askYiyiTo('walkRight', `${state.petName}正在桌面上散一小会儿步`)}
                >
                  <span>➜</span><strong>去散步</strong><small>带起小尘埃</small>
                </button>
                <button
                  className={previewAction === 'sleepy' ? styles.actionButtonActive : ''}
                  type="button"
                  aria-pressed={previewAction === 'sleepy'}
                  onClick={() => askYiyiTo('sleepy', `${state.petName}打了个哈欠，准备休息一下`)}
                >
                  <span>zZ</span><strong>休息一下</strong><small>冒出瞌睡泡泡</small>
                </button>
                <button
                  className={previewAction === 'petted' ? styles.actionButtonActive : ''}
                  type="button"
                  aria-pressed={previewAction === 'petted'}
                  onClick={() => askYiyiTo('petted', `刚刚摸了摸${state.petName}的头，脸都红啦`)}
                >
                  <span>♡</span><strong>摸摸头</strong><small>害羞脸红</small>
                </button>
              </div>
            </section>
              </>
            )}

            {activeView === 'settings' && (
              <>
            <section className={styles.characterPanel}>
              <div className={styles.sectionHeading}>
                <div><span>CHARACTER CLOSET</span><h2>角色衣柜</h2></div>
                <em>当前：{activeCharacter.name}</em>
              </div>

              <div className={styles.characterUpload}>
                <label>
                  <span>衣柜款式名称</span>
                  <input
                    value={characterName}
                    maxLength={20}
                    onChange={(event) => setCharacterName(event.target.value)}
                    placeholder="例如：粉色小帽、经典小鼠"
                  />
                </label>
                <label>
                  <span>图片类型</span>
                  <select
                    value={characterLayout}
                    onChange={(event) => setCharacterLayout(
                      event.target.value as CharacterLayout,
                    )}
                  >
                    <option value="single">单张透明角色图</option>
                    <option value="sheet">4×2 动作精灵图</option>
                  </select>
                </label>
                <label className={styles.uploadButton}>
                  <input
                    type="file"
                    accept="image/png,image/webp"
                    disabled={isUploadingCharacter}
                    onChange={uploadCharacter}
                  />
                  {isUploadingCharacter ? '正在加入…' : '上传并启用'}
                </label>
              </div>
              <p className={styles.characterHint}>
                支持 PNG/WebP，最大 4 MB。透明背景效果最好；单图会自动模拟动作，
                4×2 精灵图可使用专门的挥手、走路、跳跃与睡觉帧。
              </p>

              <div className={styles.characterGrid}>
                {characters.map((character) => (
                  <article
                    key={character.id}
                    className={
                      character.id === activeCharacter.id ? styles.activeCharacter : undefined
                    }
                  >
                    <div
                      className={character.layout === 'single' ? styles.singlePortrait : ''}
                      style={{ backgroundImage: `url(${JSON.stringify(character.imageUrl)})` }}
                    />
                    <span>{character.layout === 'sheet' ? '4×2 动作' : '单图动画'}</span>
                    <strong>{character.name}</strong>
                    <div className={styles.characterActions}>
                      <button
                        type="button"
                        disabled={character.id === activeCharacter.id}
                        onClick={() => postHostMessage(
                          'character.activate',
                          { id: character.id },
                        )}
                      >
                        {character.id === activeCharacter.id ? '使用中' : '换成她'}
                      </button>
                      {!character.builtIn && (
                        <button type="button" onClick={() => deleteCharacter(character)}>
                          删除
                        </button>
                      )}
                    </div>
                  </article>
                ))}
              </div>
            </section>

            <section className={styles.preferencesPanel}>
              <div className={styles.sectionHeading}>
                <div><span>PERSONALITY</span><h2>名字与提醒声音</h2></div>
                <em>{settingsSaved || '设置会保存在本机'}</em>
              </div>
              <div className={styles.preferencesGrid}>
                <form className={styles.nameForm} onSubmit={savePetName}>
                  <label htmlFor="pet-name">小助手名字</label>
                  <div>
                    <input
                      id="pet-name"
                      value={draftName}
                      maxLength={16}
                      onChange={(event) => setDraftName(event.target.value)}
                      aria-label="小助手名字"
                    />
                    <button type="submit">保存名字</button>
                  </div>
                </form>
                <div className={styles.soundToggles}>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={state.soundEnabled}
                    className={state.soundEnabled ? styles.toggleActive : undefined}
                    onClick={() => updateSettings({ soundEnabled: !state.soundEnabled })}
                  >
                    <i /><span><strong>提醒音</strong><small>到点播放提示音</small></span>
                  </button>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={state.speechEnabled}
                    className={state.speechEnabled ? styles.toggleActive : undefined}
                    onClick={() => updateSettings({ speechEnabled: !state.speechEnabled })}
                  >
                    <i /><span><strong>语音播报</strong><small>朗读宠物名和事项</small></span>
                  </button>
                </div>
              </div>
            </section>

            <section className={styles.autoHidePanel}>
              <div className={styles.sectionHeading}>
                <div><span>DESKTOP BEHAVIOR</span><h2>自动收起</h2></div>
                <em>{state.autoHideEnabled ? `${state.autoHideMinutes} 分钟后` : '已关闭'}</em>
              </div>
              <div className={styles.autoHideControls}>
                <button
                  type="button"
                  role="switch"
                  aria-checked={state.autoHideEnabled}
                  className={state.autoHideEnabled ? styles.toggleActive : undefined}
                  onClick={() => updateSettings({
                    autoHideEnabled: !state.autoHideEnabled,
                  })}
                >
                  <i />
                  <span>
                    <strong>无人操作时缩到屏幕边缘</strong>
                    <small>恢复鼠标或键盘操作后会自动回来，提醒到点也会立即出现</small>
                  </span>
                </button>
                <label>
                  <span>等待时间</span>
                  <select
                    value={state.autoHideMinutes}
                    disabled={!state.autoHideEnabled}
                    onChange={(event) => updateSettings({
                      autoHideMinutes: Number(event.target.value),
                    })}
                    aria-label="自动收起等待时间"
                  >
                    {autoHideMinuteOptions.map((minutes) => (
                      <option key={minutes} value={minutes}>
                        {minutes} 分钟
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            </section>
              </>
            )}

            {activeView === 'status' && (
            <article className={styles.statusTip}>
              <span>{state.petName}的小建议</span>
              <strong>{nextReminder ? `下一件事是“${nextReminder.title}”` : '今天没有紧急的事，记得喝水和伸展一下。'}</strong>
            </article>
            )}
          </section>
        ) : (
          <>
            {activeView === 'all' ? (
              <section className={styles.allOverview}>
                <article className={styles.allFocusCard}>
                  <span>NEXT UP</span>
                  <small>下一项安排</small>
                  <strong>{reminders[0]?.title ?? '暂时没有待办啦'}</strong>
                  <em>{reminders[0] ? `${formatDate(reminders[0].dueAt)} · ${relativeTime(reminders[0].dueAt)}` : `和${state.petName}轻松一下`}</em>
                </article>
                <article><span>全部待办</span><strong>{reminders.length}</strong><small>项</small></article>
                <article className={allReminderCounts.overdue ? styles.warningStat : undefined}><span>已经超时</span><strong>{allReminderCounts.overdue}</strong><small>项</small></article>
                <article><span>未来 7 天</span><strong>{allReminderCounts.week}</strong><small>项</small></article>
                <article><span>重复提醒</span><strong>{allReminderCounts.repeating}</strong><small>项</small></article>
              </section>
            ) : (
              <section className={styles.overviewGrid}>
                <article className={styles.nextCard}>
                  <span>今天下一项提醒</span>
                  {nextReminder ? (
                    <><strong>{nextReminder.title}</strong><div><time>{formatDate(nextReminder.dueAt)}</time><em>{relativeTime(nextReminder.dueAt)}</em></div></>
                  ) : (
                    <><strong>今天没有待办啦</strong><div><time>和{state.petName}一起休息一会儿</time></div></>
                  )}
                </article>
                <article className={styles.statCard}><span>今天还有</span><strong>{visibleReminders.length}</strong><small>件小事</small></article>
              </section>
            )}

            <section className={styles.reminderPanel}>
              <div className={styles.sectionHeading}>
                <div>
                  <span>REMINDERS</span>
                  <h2>{activeView === 'all' ? '全部未完成事项' : '今天接下来要做'}</h2>
                </div>
                <em>{visibleReminders.length} 项未完成</em>
              </div>

              <form className={styles.quickForm} onSubmit={submitReminder}>
                <div className={styles.titleField}>
                  <span>+</span>
                  <input
                    value={title}
                    onChange={(event) => setTitle(event.target.value)}
                    maxLength={160}
                    placeholder="写下一件要记住的事…"
                    aria-label="事项名称"
                  />
                </div>
                <input
                  className={styles.timeField}
                  type="datetime-local"
                  value={dueAt}
                  onChange={(event) => setDueAt(event.target.value)}
                  aria-label="提醒时间"
                />
                <select
                  className={styles.repeatField}
                  value={repeatRule}
                  onChange={(event) => setRepeatRule(event.target.value as RepeatRule)}
                  aria-label="重复频率"
                >
                  <option value="none">仅一次</option>
                  <option value="daily">每天</option>
                  <option value="weekdays">工作日</option>
                  <option value="weekly">每周</option>
                </select>
                <select
                  className={styles.priorityField}
                  value={priority}
                  onChange={(event) => setPriority(event.target.value as ReminderPriority)}
                  aria-label="紧急程度"
                >
                  <option value="normal">日常</option>
                  <option value="important">重要</option>
                  <option value="urgent">紧急</option>
                </select>
                <button type="submit">交给{state.petName}</button>
              </form>

              {error && <div className={styles.errorMessage}>{error}</div>}

              {activeView === 'all' && (
                <div className={styles.allOrganizer}>
                  <label><span>⌕</span><input value={allReminderQuery} onChange={(event) => setAllReminderQuery(event.target.value)} placeholder="搜索全部事项…" /></label>
                  <div>
                    {([
                      ['all', '全部'], ['overdue', '超时'], ['today', '今天'],
                      ['upcoming', '未到期'], ['repeating', '重复'], ['urgent', '紧急'],
                    ] as [AllReminderFilter, string][]).map(([id, label]) => (
                      <button key={id} type="button" className={allReminderFilter === id ? styles.organizerActive : undefined} onClick={() => setAllReminderFilter(id)}>{label}</button>
                    ))}
                  </div>
                </div>
              )}

              <div className={`${styles.reminderList} ${activeView === 'all' ? styles.allReminderList : ''}`}>
                {visibleReminders.length === 0 ? (
                  <div className={styles.emptyState}>
                    <span>✓</span>
                    <strong>暂时没有事情追着你跑</strong>
                    <p>在上面添加一项，{state.petName}会准时来找你。</p>
                  </div>
                ) : (
                  reminderGroups.map((group) => (
                    <section className={styles.reminderGroup} key={group.id}>
                      {activeView === 'all' && <header><strong>{group.label}</strong><span>{group.items.length} 项</span></header>}
                      {group.items.map((reminder) => (
                        <article className={`${styles.reminderItem} ${priorityClassNames[reminder.priority]}`} key={reminder.id}>
                          <button className={styles.checkButton} type="button" aria-label={`完成 ${reminder.title}`} onClick={() => complete(reminder)} />
                          <div className={styles.reminderText}>
                            <strong>{reminder.title}</strong>
                            <div>
                              <span>{reminder.id === nextReminder?.id ? '下一项' : relativeTime(reminder.dueAt)}</span>
                              {reminder.repeatRule !== 'none' && <em className={styles.repeatBadge}>↻ {repeatLabels[reminder.repeatRule]}</em>}
                              <em className={styles.priorityBadge}>{priorityLabels[reminder.priority]}</em>
                            </div>
                          </div>
                          <time>{formatDate(reminder.dueAt)}</time>
                          <button className={styles.deleteButton} type="button" aria-label={`删除 ${reminder.title}`} onClick={() => postHostMessage('reminder.delete', { id: reminder.id })}>×</button>
                        </article>
                      ))}
                    </section>
                  ))
                )}
              </div>
            </section>
          </>
        )}
      </main>
    </div>
  );
}
