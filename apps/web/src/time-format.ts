function parsedDate(value: string | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

export function formatCompactDateTime(
  value: string | undefined,
  referenceDate: Date = new Date(),
): string | null {
  const date = parsedDate(value);
  if (!date) return null;
  const currentYear = referenceDate.getFullYear();
  const datePart = date.getFullYear() === currentYear
    ? `${pad(date.getMonth() + 1)}/${pad(date.getDate())}`
    : `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())}`;
  return `${datePart} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function formatFullDateTime(value: string | undefined): string | null {
  const date = parsedDate(value);
  if (!date) return null;
  return `${date.getFullYear()}年${pad(date.getMonth() + 1)}月${pad(date.getDate())}日 ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export function normalizedDateTime(value: string | undefined): string | undefined {
  return parsedDate(value)?.toISOString();
}
