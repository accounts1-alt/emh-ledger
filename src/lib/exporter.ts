import * as XLSX from 'xlsx';

/** Save a simple table as an Excel file. */
export function exportSheet(name: string, rows: (string | number | null)[][]) {
  const ws = XLSX.utils.aoa_to_sheet(rows);
  ws['!cols'] = rows[0].map((_, i) => ({ wch: Math.min(40, Math.max(10, ...rows.slice(0, 200).map(r => String(r[i] ?? '').length + 2))) }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, name.slice(0, 31).replace(/[\\/?*[\]:]/g, '-'));
  XLSX.writeFile(wb, `${name.replace(/[\\/?*[\]:]/g, '-')}.xlsx`);
}
