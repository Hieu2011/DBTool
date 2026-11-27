import { useState } from 'react';
import * as Popover from '@radix-ui/react-popover';
import { DayPicker } from 'react-day-picker';
import { IconCalendar } from './icons';

export const isDateType = (strDataType: string) => /^(date|timestamp)/i.test(strDataType);

interface Props {
  /** The text being edited; the picker starts at the date (and time) it holds. */
  strValue: string;
  boolDateOnly: boolean;
  boolSmall?: boolean;
  /** yyyy-MM-dd, or yyyy-MM-dd HH:mm:ss. */
  onPick: (strValue: string) => void;
  onOpenChange?: (boolOpen: boolean) => void;
}

const pad = (intValue: number) => String(intValue).padStart(2, '0');
const TIME_PARTS: { label: string; max: number }[] = [{ label: 'Hours', max: 23 }, { label: 'Minutes', max: 59 }, { label: 'Seconds', max: 59 }];

// Tailwind on the app's own colors; the library's stylesheet is not loaded.
const CALENDAR_CLASSES = {
  root: 'select-none text-xs',
  months: 'relative',
  month_caption: 'flex h-8 items-center justify-center',
  dropdowns: 'flex items-center gap-1',
  dropdown_root: 'relative inline-flex h-6 items-center rounded px-1.5 font-semibold hover:bg-hover focus-within:bg-hover',
  // The list itself is the browser's: its rows take the app's colors, or they come out light on white.
  dropdown: 'absolute inset-0 cursor-pointer opacity-0 [&>option]:bg-panel [&>option]:text-fg',
  caption_label: 'inline-flex items-center gap-1',
  nav: 'pointer-events-none absolute inset-x-0 top-0 z-10 flex h-8 items-center justify-between',
  button_previous: 'icon-btn icon-btn-sm pointer-events-auto',
  button_next: 'icon-btn icon-btn-sm pointer-events-auto',
  chevron: 'h-3 w-3 fill-current',
  month_grid: 'mx-auto border-collapse',
  weekday: 'h-7 w-8 text-[11px] font-normal uppercase text-muted',
  day: 'h-8 w-8 p-0 text-center',
  day_button: 'h-7 w-7 rounded-md outline-none hover:bg-hover focus-visible:shadow-[inset_0_0_0_1px_var(--accent)]',
  selected: '[&>button]:bg-accent [&>button]:font-semibold [&>button]:text-accent-fg [&>button]:hover:bg-accent',
  today: '[&>button]:shadow-[inset_0_0_0_1px_var(--accent)]',
  outside: 'opacity-40',
};

/** Calendar button: a month grid with the time under it. A click on a day (or OK) writes the text and closes. */
export function DatePickerButton({ strValue, boolDateOnly, boolSmall, onPick, onOpenChange }: Props) {
  const [boolOpen, setBoolOpen] = useState(false);
  const [objDay, setObjDay] = useState<Date>(() => new Date());
  const [objMonth, setObjMonth] = useState<Date>(() => new Date());
  const [arrTime, setArrTime] = useState<string[]>(['00', '00', '00']);
  const objToday = new Date();

  const open = (boolNext: boolean) => {
    if (boolNext) {
      // Start from what is typed, when it is a date; else today at 00:00:00.
      const arrMatch = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(strValue.trim());
      const objStart = arrMatch ? new Date(Number(arrMatch[1]), Number(arrMatch[2]) - 1, Number(arrMatch[3])) : new Date();
      setObjDay(objStart);
      setObjMonth(objStart);
      setArrTime([arrMatch?.[4] ?? '00', arrMatch?.[5] ?? '00', arrMatch?.[6] ?? '00']);
    }
    setBoolOpen(boolNext);
    onOpenChange?.(boolNext);
  };

  const apply = (objDate: Date, arrClock = arrTime) => {
    const strDate = `${objDate.getFullYear()}-${pad(objDate.getMonth() + 1)}-${pad(objDate.getDate())}`;
    onPick(boolDateOnly ? strDate : `${strDate} ${arrClock.map((strPart, intPart) => pad(Math.min(Number(strPart) || 0, TIME_PARTS[intPart].max))).join(':')}`);
    open(false);
  };

  const setPart = (intPart: number, strText: string) =>
    setArrTime(arrPrev => arrPrev.map((strOld, intAt) => (intAt === intPart ? strText.replace(/\D/g, '').slice(0, 2) : strOld)));
  const stepPart = (intPart: number, intStep: number) => setArrTime(arrPrev => arrPrev.map((strOld, intAt) => {
    const intSize = TIME_PARTS[intPart].max + 1;
    return intAt === intPart ? pad((((Number(strOld) || 0) + intStep) % intSize + intSize) % intSize) : strOld;
  }));
  const now = () => {
    // Same as a click on a day: the text is written at once.
    const objNow = new Date();
    apply(objNow, [pad(objNow.getHours()), pad(objNow.getMinutes()), pad(objNow.getSeconds())]);
  };

  return (
    <Popover.Root open={boolOpen} onOpenChange={open}>
      <Popover.Trigger asChild>
        <button type="button" className={`icon-btn shrink-0 ${boolSmall ? 'icon-btn-sm' : ''}`} aria-label="Pick a date" title="Pick a date">
          <IconCalendar intSize={boolSmall ? 13 : 15} />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content align="end" sideOffset={6} collisionPadding={8} data-cell-popover onOpenAutoFocus={objEvent => objEvent.preventDefault()}
          className="z-50 rounded-lg border border-line bg-panel p-2.5 font-sans text-fg shadow-2xl outline-none">
          <button type="button" onClick={now} title={boolDateOnly ? 'Set today' : 'Set today, at the current time'}
            className="mb-1 block w-full rounded px-2 py-1 text-center text-[11px] text-muted hover:bg-hover hover:text-fg">
            Today · {objToday.toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}
          </button>
          {/* onSelect is what makes `selected` controlled: without it the library keeps its first value. */}
          <DayPicker mode="single" required selected={objDay} onSelect={setObjDay} month={objMonth} onMonthChange={setObjMonth}
            onDayClick={objDate => apply(objDate)}
            captionLayout="dropdown" startMonth={new Date(1990, 0)} endMonth={new Date(objToday.getFullYear() + 10, 11)}
            showOutsideDays fixedWeeks weekStartsOn={1}
            modifiers={{ weekend: { dayOfWeek: [0, 6] } }} modifiersClassNames={{ weekend: 'text-danger' }}
            classNames={CALENDAR_CLASSES} />
          {!boolDateOnly && (
            <div className="mt-2 flex items-center gap-1 border-t border-line pt-2">
              <span className="mr-1 text-[11px] text-muted">Time</span>
              {TIME_PARTS.map((objPart, intPart) => (
                <span key={objPart.label} className="flex items-center gap-0.5">
                  {intPart > 0 && <span className="px-0.5 text-muted">:</span>}
                  <input value={arrTime[intPart]} aria-label={objPart.label} inputMode="numeric" maxLength={2}
                    title={`${objPart.label} (0–${objPart.max}); ↑ ↓ to step`}
                    onChange={objEvent => setPart(intPart, objEvent.target.value)}
                    onFocus={objEvent => objEvent.target.select()}
                    onBlur={() => stepPart(intPart, 0)}
                    onKeyDown={objEvent => {
                      if (objEvent.key === 'ArrowUp') { stepPart(intPart, 1); objEvent.preventDefault(); }
                      else if (objEvent.key === 'ArrowDown') { stepPart(intPart, -1); objEvent.preventDefault(); }
                      else if (objEvent.key === 'Enter') apply(objDay);
                    }}
                    className="field h-7 w-9 px-0 text-center font-mono text-xs" />
                  <span className="flex flex-col">
                    {[1, -1].map(intStep => (
                      <button key={intStep} type="button" tabIndex={-1} onClick={() => stepPart(intPart, intStep)}
                        aria-label={`${intStep > 0 ? 'Increase' : 'Decrease'} ${objPart.label.toLowerCase()}`}
                        className="flex h-3.5 w-4 items-center justify-center rounded-sm text-muted hover:bg-hover hover:text-fg">
                        <svg width="8" height="8" viewBox="0 0 8 8" aria-hidden="true" fill="currentColor">
                          <path d={intStep > 0 ? 'M4 1.5 7.5 6.5h-7z' : 'M4 6.5.5 1.5h7z'} />
                        </svg>
                      </button>
                    ))}
                  </span>
                </span>
              ))}
              <button type="button" className="btn btn-primary ml-auto h-7 px-3" onClick={() => apply(objDay)}>OK</button>
            </div>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
