import { useEffect, useMemo, useRef, useState } from 'react';
import { postHostMessage, subscribeHost } from '../bridge/hostBridge';
import type { AppState, HostMessage, Reminder, ReminderPriority } from '../types';
import styles from './Pet.module.scss';

type PetAction = 'idle' | 'walkLeft' | 'walkRight' | 'wave' | 'hop' | 'sleepy' | 'petted';

const emptyState: AppState = {
  reminders: [],
  now: Date.now(),
  petName: '可爱依依',
  soundEnabled: true,
  speechEnabled: false,
};

const priorityClassNames: Record<ReminderPriority, string> = {
  normal: styles.priorityNormal,
  important: styles.priorityImportant,
  urgent: styles.priorityUrgent,
};

function formatShortTime(timestamp: number) {
  return new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
  }).format(timestamp);
}

export function Pet() {
  const isPresentationDemo =
    import.meta.env.DEV &&
    new URLSearchParams(window.location.search).get('demo') === 'reminder';
  const demoReminder: Reminder | null = isPresentationDemo
    ? {
        id: -1,
        title: '整理并提交今晚的 C++17 桌面宠物学习笔记',
        dueAt: Date.now(),
        completed: false,
        notified: true,
        repeatRule: 'none',
        priority: 'urgent',
      }
    : null;
  const [state, setState] = useState<AppState>(emptyState);
  const [action, setAction] = useState<PetAction>(isPresentationDemo ? 'hop' : 'idle');
  const [activeReminder, setActiveReminder] = useState<Reminder | null>(demoReminder);
  const activeReminderRef = useRef<Reminder | null>(demoReminder);
  const [isPresenting, setIsPresenting] = useState(isPresentationDemo);
  const [message, setMessage] = useState('嗨，我是可爱依依！');
  const [hour, setHour] = useState(new Date().getHours());
  const [celebrating, setCelebrating] = useState(false);
  const celebrationTimer = useRef<number>();

  const triggerCelebration = () => {
    setCelebrating(true);
    window.clearTimeout(celebrationTimer.current);
    celebrationTimer.current = window.setTimeout(() => setCelebrating(false), 1900);
  };

  const nextReminder = useMemo(
    () => state.reminders.find((reminder) => !reminder.completed) ?? null,
    [state.reminders],
  );

  useEffect(() => {
    const unsubscribe = subscribeHost((hostMessage: HostMessage) => {
      if (hostMessage.type === 'state.sync') {
        const nextState = hostMessage.payload as AppState;
        setState(nextState);
        if (!activeReminderRef.current) setMessage(`嗨，我是${nextState.petName}！`);
      }
      if (hostMessage.type === 'reminder.triggered') {
        const reminder = hostMessage.payload as Reminder;
        activeReminderRef.current = reminder;
        setActiveReminder(reminder);
        setIsPresenting(true);
        setMessage('到时间啦！');
        setAction('hop');
      }
      if (hostMessage.type === 'reminder.dismissed') {
        activeReminderRef.current = null;
        setActiveReminder(null);
        setIsPresenting(false);
        setMessage('好，晚点再叫你。');
        setAction('wave');
      }
      if (hostMessage.type === 'presentation.ended') {
        setIsPresenting(false);
        setMessage('我先回去啦，别忘了这件事哦。');
        setAction('idle');
      }
      if (hostMessage.type === 'pet.action') {
        const requested = (hostMessage.payload as { action?: PetAction })?.action;
        if (requested) {
          setAction(requested);
          if (requested === 'petted') {
            setMessage('嘿嘿，谢谢你摸摸我，脸都红啦。');
          }
        }
      }
      if (hostMessage.type === 'reminder.completed') {
        triggerCelebration();
        setMessage('完成啦，真棒！');
        setAction('wave');
      }
      if (hostMessage.type === 'app.error') {
        setMessage((hostMessage.payload as { message: string }).message);
      }
    });

    postHostMessage('app.ready');
    return () => {
      unsubscribe();
      window.clearTimeout(celebrationTimer.current);
    };
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => setHour(new Date().getHours()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (activeReminder) return;
    const timer = window.setInterval(() => {
      const hour = new Date().getHours();
      if (hour >= 23 || hour < 7) {
        setAction('sleepy');
        setMessage('夜深了，早点休息呀。');
        return;
      }
      const choices: PetAction[] = ['idle', 'idle', 'wave', 'walkLeft', 'walkRight'];
      const nextAction = choices[Math.floor(Math.random() * choices.length)];
      setAction(nextAction);
      if (nextAction === 'wave') setMessage('今天也要加油！');
    }, 9_000);
    return () => window.clearInterval(timer);
  }, [activeReminder]);

  useEffect(() => {
    if (action === 'idle' || action === 'sleepy' || activeReminder) return;
    const timer = window.setTimeout(() => setAction('idle'), 2_200);
    return () => window.clearTimeout(timer);
  }, [action, activeReminder]);

  const completeReminder = () => {
    if (!activeReminder) return;
    postHostMessage('reminder.complete', { id: activeReminder.id });
    triggerCelebration();
    activeReminderRef.current = null;
    setActiveReminder(null);
    setIsPresenting(false);
    setMessage('完成啦，真棒！');
    setAction('wave');
  };

  const snoozeReminder = () => {
    if (!activeReminder) return;
    postHostMessage('reminder.snooze', { id: activeReminder.id, minutes: 5 });
    setIsPresenting(false);
  };

  const priorityClass = activeReminder
    ? priorityClassNames[activeReminder.priority]
    : styles.priorityNormal;
  const isNight = hour >= 21 || hour < 7;

  return (
    <section
      className={`${styles.stage} ${isPresenting ? styles.presentationStage : ''} ${priorityClass}`}
      onDoubleClick={() => {
        if (!isPresenting) postHostMessage('window.openDashboard');
      }}
    >
      {celebrating && (
        <div className={styles.completionBurst} aria-live="polite">
          <strong>太棒啦！</strong>
          {['✦', '♥', '●', '◆', '✦', '♥', '●', '◆', '✦', '♥'].map((piece, index) => (
            <i key={`${piece}-${index}`}>{piece}</i>
          ))}
        </div>
      )}
      {!isPresenting && (
        <div className={`${styles.bubble} ${activeReminder ? styles.bubbleUrgent : ''}`}>
          <span className={styles.bubbleEyebrow}>
            {activeReminder
              ? activeReminder.repeatRule === 'none'
                ? '提醒时间到'
                : '重复提醒时间到'
              : `${state.petName}悄悄说`}
          </span>
          <strong>{activeReminder?.title ?? message}</strong>
          {activeReminder && (
            <div className={styles.bubbleActions}>
              <button type="button" onClick={completeReminder}>完成</button>
              <button type="button" onClick={snoozeReminder}>5 分钟后</button>
            </div>
          )}
        </div>
      )}

      {isPresenting && activeReminder && (
        <div className={styles.presentation} role="alert" aria-live="assertive">
          <div className={styles.spotlight} aria-hidden="true" />
          <span className={`${styles.sparkle} ${styles.sparkleOne}`} aria-hidden="true">✦</span>
          <span className={`${styles.sparkle} ${styles.sparkleTwo}`} aria-hidden="true">✦</span>
          <span className={`${styles.sparkle} ${styles.sparkleThree}`} aria-hidden="true">●</span>
          <span className={styles.urgencyRing} aria-hidden="true" />
          <span className={`${styles.alertRay} ${styles.alertRayOne}`} aria-hidden="true" />
          <span className={`${styles.alertRay} ${styles.alertRayTwo}`} aria-hidden="true" />

          <div className={styles.signBoard}>
            <span className={styles.signKicker}>
              {activeReminder.repeatRule === 'none'
                ? `${state.petName}提醒你`
                : `${state.petName}的重复提醒`}
            </span>
            <strong>{activeReminder.title}</strong>
            <span className={styles.signHint}>现在该做这件事啦</span>
            <div className={styles.signActions}>
              <button type="button" onClick={completeReminder}>完成啦</button>
              <button type="button" onClick={snoozeReminder}>5 分钟后</button>
            </div>
          </div>
          <div className={styles.signPost} aria-hidden="true" />
          <span className={styles.autoReturnHint}>稍后自动回到原位</span>
        </div>
      )}

      <button
        className={styles.dashboardButton}
        type="button"
        aria-label="打开事项中心"
        onClick={() => postHostMessage('window.openDashboard')}
      >
        +
      </button>

      <div
        className={`${styles.spriteShell} ${styles[action]}`}
        onPointerDown={(event) => {
          if (event.button === 0 && !isPresenting) postHostMessage('window.drag');
        }}
        role="img"
        aria-label={`可爱的桌面小鼠${state.petName}`}
      >
        <div className={`${styles.sprite} ${styles[action]}`} />
        <span className={`${styles.cheek} ${styles.cheekLeft}`} aria-hidden="true" />
        <span className={`${styles.cheek} ${styles.cheekRight}`} aria-hidden="true" />
        <div className={`${styles.outfit} ${isNight ? styles.nightOutfit : styles.dayOutfit}`} aria-hidden="true">
          <span className={styles.dayFlower}>✿</span>
          <span className={styles.nightCap}><i /></span>
        </div>
      </div>

      {!isPresenting && (
        <button
          className={styles.patHotspot}
          type="button"
          aria-label={`摸摸${state.petName}的头`}
          title={`摸摸${state.petName}`}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={() => postHostMessage('pet.action', { action: 'petted' })}
        />
      )}

      <div className={`${styles.actionEffects} ${styles[action]}`} aria-hidden="true">
        <span className={`${styles.heartFx} ${styles.heartOne}`}>♥</span>
        <span className={`${styles.heartFx} ${styles.heartTwo}`}>♥</span>
        <span className={`${styles.heartFx} ${styles.heartThree}`}>♥</span>
        <span className={`${styles.sleepFx} ${styles.sleepOne}`}>z</span>
        <span className={`${styles.sleepFx} ${styles.sleepTwo}`}>Z</span>
        <i className={`${styles.dustFx} ${styles.dustOne}`} />
        <i className={`${styles.dustFx} ${styles.dustTwo}`} />
        <span className={styles.hopFx}>✦</span>
      </div>

      {nextReminder && !activeReminder && !isPresenting && (
        <button
          className={styles.nextReminder}
          type="button"
          onClick={() => postHostMessage('window.openDashboard')}
        >
          <span>{formatShortTime(nextReminder.dueAt)}</span>
          <strong>{nextReminder.title}</strong>
        </button>
      )}
    </section>
  );
}
