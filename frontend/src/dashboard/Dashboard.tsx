import { FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import { postHostMessage, subscribeHost } from '../bridge/hostBridge';
import type {
  AppState,
  HostMessage,
  Reminder,
  ReminderPriority,
  RepeatRule,
} from '../types';
import styles from './Dashboard.module.scss';

type DashboardView = 'today' | 'all' | 'status';
type PetAction = 'wave' | 'hop' | 'walkRight' | 'sleepy' | 'petted';

const initialState: AppState = {
  reminders: [],
  now: Date.now(),
  petName: '可爱依依',
  soundEnabled: true,
  speechEnabled: false,
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

export function Dashboard() {
  const [state, setState] = useState<AppState>(initialState);
  const [activeView, setActiveView] = useState<DashboardView>('today');
  const [title, setTitle] = useState('');
  const [dueAt, setDueAt] = useState(toDateTimeInput(Date.now() + 30 * 60_000));
  const [repeatRule, setRepeatRule] = useState<RepeatRule>('none');
  const [priority, setPriority] = useState<ReminderPriority>('normal');
  const [error, setError] = useState('');
  const [lastAction, setLastAction] = useState('正在陪你安静待机');
  const [draftName, setDraftName] = useState(initialState.petName);
  const [settingsSaved, setSettingsSaved] = useState('');
  const [celebrating, setCelebrating] = useState(false);
  const celebrationTimer = useRef<number>();

  useEffect(() => {
    const unsubscribe = subscribeHost((message: HostMessage) => {
      if (message.type === 'state.sync') {
        setState(message.payload as AppState);
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
    };
  }, []);

  useEffect(() => {
    setDraftName(state.petName);
  }, [state.petName]);

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
  const visibleReminders = activeView === 'all' ? reminders : todayReminders;
  const nextReminder = visibleReminders[0] ?? null;
  const repeatingCount = reminders.filter((reminder) => reminder.repeatRule !== 'none').length;
  const hour = new Date().getHours();
  const petMood = hour >= 23 || hour < 7 ? '有一点困啦' : '精神满满';

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
    postHostMessage('pet.action', { action });
    setLastAction(description);
  };

  const updateSettings = (patch: Partial<Pick<AppState, 'petName' | 'soundEnabled' | 'speechEnabled'>>) => {
    postHostMessage('settings.update', {
      petName: patch.petName ?? state.petName,
      soundEnabled: patch.soundEnabled ?? state.soundEnabled,
      speechEnabled: patch.speechEnabled ?? state.speechEnabled,
    });
    setSettingsSaved('设置已保存');
    window.setTimeout(() => setSettingsSaved(''), 1600);
  };

  const savePetName = (event: FormEvent) => {
    event.preventDefault();
    const nextName = draftName.trim();
    if (!nextName) {
      setError('请先给小鼠取一个名字。');
      return;
    }
    updateSettings({ petName: nextName });
  };

  const brandInitial = Array.from(state.petName.trim())[0] ?? '依';

  const viewHeading = activeView === 'all'
      ? '所有小事，都在这里。'
    : activeView === 'status'
      ? `${state.petName}，今天也在陪你。`
      : `${greetingForHour(hour)}，慢慢来就好。`;
  const viewDescription = activeView === 'all'
    ? '一次看看所有待办和重复提醒。'
    : activeView === 'status'
      ? `看看${state.petName}的状态，也可以叫她做个小动作。`
      : `${state.petName}会帮你看着时间，不让重要的小事溜走。`;

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
      <aside className={styles.sidebar}>
        <div className={styles.brand}>
          <div className={styles.brandMark}>{brandInitial}</div>
          <div>
            <strong>{state.petName}</strong>
            <span>陪你记住小事</span>
          </div>
        </div>

        <nav className={styles.navigation} aria-label="主要导航">
          <button
            className={activeView === 'today' ? styles.activeNav : undefined}
            type="button"
            aria-pressed={activeView === 'today'}
            onClick={() => setActiveView('today')}
          >
            <span>⌁</span>今天
            <em>{todayReminders.length}</em>
          </button>
          <button
            className={activeView === 'all' ? styles.activeNav : undefined}
            type="button"
            aria-pressed={activeView === 'all'}
            onClick={() => setActiveView('all')}
          >
            <span>◷</span>全部事项
            <em>{reminders.length}</em>
          </button>
          <button
            className={activeView === 'status' ? styles.activeNav : undefined}
            type="button"
            aria-pressed={activeView === 'status'}
            onClick={() => setActiveView('status')}
          >
            <span>✦</span>{state.petName}状态
          </button>
        </nav>

        <button
          className={styles.petCard}
          type="button"
          onClick={() => setActiveView('status')}
        >
          <div className={styles.petPortrait} />
          <div>
            <span>{state.petName}现在</span>
            <strong>{petMood}</strong>
          </div>
          <i />
        </button>

        <button className={styles.testButton} type="button" onClick={createDemoReminder}>
          10 秒后测试提醒
        </button>
      </aside>

      <main className={styles.content}>
        <header className={styles.header}>
          <div>
            <span className={styles.kicker}>CUTE COMPANION ROUTINE</span>
            <h1>{viewHeading}</h1>
            <p>{viewDescription}</p>
          </div>
          <button
            className={styles.closeButton}
            type="button"
            aria-label="关闭事项中心"
            onClick={() => postHostMessage('window.hideDashboard')}
          >
            ×
          </button>
        </header>

        {activeView === 'status' ? (
          <section className={styles.statusView}>
            <article className={styles.statusHero}>
              <div className={styles.statusPortrait}>
                <div />
                <span aria-hidden="true">♥</span>
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
                <em>动作会立刻显示在桌面上</em>
              </div>
              <div className={styles.actionGrid}>
                <button type="button" onClick={() => askYiyiTo('wave', `${state.petName}刚刚开心地向你挥了挥手`)}>
                  <span>♥</span><strong>挥挥手</strong><small>飘出小爱心</small>
                </button>
                <button type="button" onClick={() => askYiyiTo('hop', `${state.petName}刚刚为你活力满满地跳了一下`)}>
                  <span>✦</span><strong>跳一下</strong><small>闪亮登场</small>
                </button>
                <button type="button" onClick={() => askYiyiTo('walkRight', `${state.petName}正在桌面上散一小会儿步`)}>
                  <span>➜</span><strong>去散步</strong><small>带起小尘埃</small>
                </button>
                <button type="button" onClick={() => askYiyiTo('sleepy', `${state.petName}打了个哈欠，准备休息一下`)}>
                  <span>zZ</span><strong>休息一下</strong><small>冒出瞌睡泡泡</small>
                </button>
                <button type="button" onClick={() => askYiyiTo('petted', `刚刚摸了摸${state.petName}的头，脸都红啦`)}>
                  <span>♡</span><strong>摸摸头</strong><small>害羞脸红</small>
                </button>
              </div>
            </section>

            <section className={styles.preferencesPanel}>
              <div className={styles.sectionHeading}>
                <div><span>PERSONALITY</span><h2>名字与提醒声音</h2></div>
                <em>{settingsSaved || '设置会保存在本机'}</em>
              </div>
              <div className={styles.preferencesGrid}>
                <form className={styles.nameForm} onSubmit={savePetName}>
                  <label htmlFor="pet-name">宠物名字</label>
                  <div>
                    <input
                      id="pet-name"
                      value={draftName}
                      maxLength={16}
                      onChange={(event) => setDraftName(event.target.value)}
                      aria-label="宠物名字"
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

            <article className={styles.statusTip}>
              <span>{state.petName}的小建议</span>
              <strong>{nextReminder ? `下一件事是“${nextReminder.title}”` : '今天没有紧急的事，记得喝水和伸展一下。'}</strong>
            </article>
          </section>
        ) : (
          <>
            <section className={styles.overviewGrid}>
              <article className={styles.nextCard}>
                <span>{activeView === 'all' ? '最近一项提醒' : '今天下一项提醒'}</span>
                {nextReminder ? (
                  <>
                    <strong>{nextReminder.title}</strong>
                    <div>
                      <time>{formatDate(nextReminder.dueAt)}</time>
                      <em>{relativeTime(nextReminder.dueAt)}</em>
                    </div>
                  </>
                ) : (
                  <>
                    <strong>{activeView === 'all' ? '暂时没有待办啦' : '今天没有待办啦'}</strong>
                    <div><time>和{state.petName}一起休息一会儿</time></div>
                  </>
                )}
              </article>

              <article className={styles.statCard}>
                <span>{activeView === 'all' ? '全部还有' : '今天还有'}</span>
                <strong>{visibleReminders.length}</strong>
                <small>件小事</small>
              </article>
            </section>

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

              <div className={styles.reminderList}>
                {visibleReminders.length === 0 ? (
                  <div className={styles.emptyState}>
                    <span>✓</span>
                    <strong>暂时没有事情追着你跑</strong>
                    <p>在上面添加一项，{state.petName}会准时来找你。</p>
                  </div>
                ) : (
                  visibleReminders.map((reminder, index) => (
                    <article
                      className={`${styles.reminderItem} ${priorityClassNames[reminder.priority]}`}
                      key={reminder.id}
                    >
                      <button
                        className={styles.checkButton}
                        type="button"
                        aria-label={`完成 ${reminder.title}`}
                        onClick={() => complete(reminder)}
                      />
                      <div className={styles.reminderText}>
                        <strong>{reminder.title}</strong>
                        <div>
                          <span>{index === 0 ? '下一项' : relativeTime(reminder.dueAt)}</span>
                          {reminder.repeatRule !== 'none' && (
                            <em className={styles.repeatBadge}>
                              ↻ {repeatLabels[reminder.repeatRule]}
                            </em>
                          )}
                          <em className={styles.priorityBadge}>
                            {priorityLabels[reminder.priority]}
                          </em>
                        </div>
                      </div>
                      <time>{formatDate(reminder.dueAt)}</time>
                      <button
                        className={styles.deleteButton}
                        type="button"
                        aria-label={`删除 ${reminder.title}`}
                        onClick={() => postHostMessage('reminder.delete', { id: reminder.id })}
                      >
                        ×
                      </button>
                    </article>
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
