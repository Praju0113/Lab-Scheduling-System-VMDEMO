import { useEffect, useMemo, useState } from 'react';
import { Search, X } from 'lucide-react';
import { Modal } from './Modal';
import { TestCatalogItem } from '../../types';
import { frontendApi } from '../../api/frontend';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  existingTestCodes: Set<string>;
  onImported: () => void;
}

export function TestCatalogImportModal({ isOpen, onClose, existingTestCodes, onImported }: Props) {
  const [globalCatalog, setGlobalCatalog] = useState<TestCatalogItem[]>([]);
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [importing, setImporting] = useState(false);

  useEffect(() => {
    if (isOpen) {
      setLoading(true);
      setSelected(new Set());
      setSearch('');
      frontendApi.getGlobalCatalog().then(setGlobalCatalog).catch(console.error).finally(() => setLoading(false));
    }
  }, [isOpen]);

  const available = useMemo(
    () => globalCatalog.filter((t) => !existingTestCodes.has(t.test_code)),
    [globalCatalog, existingTestCodes],
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return available;
    return available.filter((t) =>
      [t.test_name, t.test_code, t.category].some((v) => v.toLowerCase().includes(q)),
    );
  }, [available, search]);

  const toggle = (code: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(code)) next.delete(code);
      else next.add(code);
      return next;
    });
  };

  const handleImport = async () => {
    if (!selected.size) return;
    setImporting(true);
    try {
      await frontendApi.bulkImportCatalog([...selected]);
      onImported();
      onClose();
    } catch (err) {
      console.error('Import failed', err);
    } finally {
      setImporting(false);
    }
  };

  const handleImportAll = async () => {
    setImporting(true);
    try {
      await frontendApi.importAllCatalog();
      onImported();
      onClose();
    } catch (err) {
      console.error('Import all failed', err);
    } finally {
      setImporting(false);
    }
  };

  if (!isOpen) return null;

  return (
    <Modal onClose={onClose} title="Import Tests from Global Catalog">
      <div className="space-y-4">
        <div className="flex gap-3">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search tests..."
              className="w-full rounded-lg border border-gray-300 py-2 pl-9 pr-3 text-sm outline-none focus:border-[#5D2582]"
            />
          </div>
          <button
            onClick={handleImportAll}
            disabled={importing || !available.length}
            className="whitespace-nowrap rounded-lg border border-[#5D2582] px-4 py-2 text-sm text-[#5D2582] hover:bg-[#f3ebf7] disabled:opacity-50"
          >
            Import All ({available.length})
          </button>
        </div>

        {loading ? (
          <p className="py-8 text-center text-sm text-gray-500">Loading global catalog...</p>
        ) : (
          <div className="max-h-[400px] overflow-auto rounded-lg border border-gray-200">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-gray-50">
                <tr className="border-b">
                  <th className="w-8 px-3 py-2" />
                  <th className="px-3 py-2 text-left text-gray-600">Test Name</th>
                  <th className="px-3 py-2 text-left text-gray-600">Code</th>
                  <th className="px-3 py-2 text-left text-gray-600">Category</th>
                  <th className="px-3 py-2 text-left text-gray-600">Duration</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((t) => (
                  <tr
                    key={t.test_code}
                    onClick={() => toggle(t.test_code)}
                    className={`cursor-pointer border-b hover:bg-gray-50 ${selected.has(t.test_code) ? 'bg-[#f3ebf7]' : ''}`}
                  >
                    <td className="px-3 py-2 text-center">
                      <input type="checkbox" checked={selected.has(t.test_code)} readOnly className="accent-[#5D2582]" />
                    </td>
                    <td className="px-3 py-2 text-gray-900">{t.test_name}</td>
                    <td className="px-3 py-2 text-gray-600">{t.test_code}</td>
                    <td className="px-3 py-2 text-gray-600">{t.category}</td>
                    <td className="px-3 py-2 text-gray-600">{t.duration_minutes} min</td>
                  </tr>
                ))}
                {!filtered.length && (
                  <tr>
                    <td colSpan={5} className="px-3 py-8 text-center text-gray-500">
                      {available.length ? 'No matches.' : 'All tests already imported.'}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}

        <div className="flex items-center justify-between pt-2">
          <span className="text-sm text-gray-500">{selected.size} selected</span>
          <div className="flex gap-3">
            <button onClick={onClose} className="rounded-lg border border-gray-300 px-4 py-2 text-sm hover:bg-gray-50">
              Cancel
            </button>
            <button
              onClick={handleImport}
              disabled={importing || !selected.size}
              className="rounded-lg bg-[#5D2582] px-4 py-2 text-sm text-white hover:bg-[#4a1e68] disabled:opacity-50"
            >
              {importing ? 'Importing...' : `Import Selected (${selected.size})`}
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
