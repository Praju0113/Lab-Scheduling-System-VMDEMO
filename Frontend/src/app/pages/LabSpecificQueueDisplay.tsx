import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { Maximize2, X } from 'lucide-react';
import nuebergLogo from '../../assets/Nueberg_Logo.png';
import { frontendApi } from '../api/frontend';
import { useAppStore } from '../store/useAppStore';
import { WaitingCandidate } from '../types';

interface QueueSnapshot {
  current: { visit_id: string; visit_test_id: number; test_name?: string | null } | null;
  next: { visit_id: string; visit_test_id: number; test_name?: string | null } | null;
  pending: Array<{ visit_id: string; visit_test_id: number; test_name?: string | null }>;
}

const uniqueById = <T extends { id: string }>(items: T[]) => {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (seen.has(item.id)) {
      return false;
    }
    seen.add(item.id);
    return true;
  });
};

export default function LabSpecificQueueDisplay() {
  const navigate = useNavigate();
  const { labId } = useParams();
  const [currentTime, setCurrentTime] = useState(new Date());
  const [queueSnapshot, setQueueSnapshot] = useState<QueueSnapshot | null>(null);
  const [waitingCandidates, setWaitingCandidates] = useState<WaitingCandidate[]>([]);
  const { visits, labs, initializeData, isLoading } = useAppStore();

  useEffect(() => {
    const timer = setInterval(() => setCurrentTime(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    void initializeData();
  }, [initializeData]);

  useEffect(() => {
    const refreshLabScreen = async () => {
      if (!labId) return;
      try {
        const [snapshot, waiting] = await Promise.all([
          frontendApi.getQueueSnapshot(labId),
          frontendApi.getWaitingCandidates(labId),
        ]);
        setQueueSnapshot(snapshot);
        setWaitingCandidates(waiting.items);
      } catch (error) {
        console.error('Failed to load lab specific queue display', error);
      }
    };

    void refreshLabScreen();
  }, [labId, labs, visits]);

  const toggleFullscreen = () => {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen();
    } else {
      document.exitFullscreen();
    }
  };

  const selectedLab = useMemo(() => labs.find((lab) => lab.id === labId) ?? null, [labId, labs]);

  const currentVisit = useMemo(() => {
    if (!queueSnapshot?.current) return null;
    return visits.find((visit) => visit.id === queueSnapshot.current?.visit_id) ?? null;
  }, [queueSnapshot, visits]);

  const nextVisit = useMemo(() => {
    if (!queueSnapshot?.next) return null;
    return visits.find((visit) => visit.id === queueSnapshot.next?.visit_id) ?? null;
  }, [queueSnapshot, visits]);

  const pendingVisits = useMemo(
    () =>
      uniqueById(
        (queueSnapshot?.pending ?? [])
          .map((item) => visits.find((visit) => visit.id === item.visit_id) ?? null)
          .filter((visit): visit is NonNullable<typeof visit> => Boolean(visit)),
      ),
    [queueSnapshot, visits],
  );

  const waitingVisits = useMemo(
    () =>
      uniqueById(
        waitingCandidates
          .map((item) => visits.find((visit) => visit.id === item.visit_id) ?? null)
          .filter((visit): visit is NonNullable<typeof visit> => Boolean(visit)),
      ),
    [visits, waitingCandidates],
  );

  if (isLoading && !selectedLab) {
    return (
      <div className="min-h-screen bg-black text-white flex items-center justify-center">
        <p className="text-2xl font-bold">Loading lab queue screen...</p>
      </div>
    );
  }

  if (!selectedLab) {
    return (
      <div className="min-h-screen bg-black text-white flex items-center justify-center">
        <div className="text-center">
          <p className="text-2xl font-bold">Lab not found</p>
          <button
            onClick={() => navigate('/receptionist')}
            className="mt-4 rounded-lg bg-white px-4 py-2 text-black"
          >
            Back to Receptionist Dashboard
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen flex-col bg-black text-white">
      <div className="bg-[#5D2582] border-b border-white border-opacity-20 flex-shrink-0">
        <div className="px-8 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-4">
              <div className="bg-white p-2 rounded-lg">
                <img src={nuebergLogo} alt="Neuberg Diagnostics" className="h-9" />
              </div>
              <div className="border-xl border-white border-opacity-30 pl-4">
                <h1 className="text-2xl mb-0.5">{selectedLab.name} Queue Display</h1>
                <p className="text-sm text-[#c8a8d8]">{selectedLab.category}</p>
              </div>
            </div>
            <div className="flex items-center gap-8">
              <div className="text-right">
                <p className="text-xl">{currentTime.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</p>
                <p className="text-sm text-[#c8a8d8]">{currentTime.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}</p>
              </div>
              <div className="flex gap-2">
                <button onClick={toggleFullscreen} className="p-2 bg-white bg-opacity-20 hover:bg-opacity-30 rounded-lg transition-colors">
                  <Maximize2 className="w-5 h-5 text-black" />
                </button>
                <button onClick={() => navigate('/receptionist')} className="p-2 bg-white bg-opacity-20 hover:bg-opacity-30 rounded-lg transition-colors">
                  <X className="w-5 h-5 text-black" />
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-hidden px-8 py-6">
        <div className="grid h-full min-h-0 grid-cols-[1.32fr_0.68fr] gap-6">
          <div className="grid min-h-0 grid-rows-[0.82fr_1.18fr] gap-6">
            <div className="grid min-h-0 grid-cols-2 gap-6">
              <section className="flex min-h-0 flex-col overflow-hidden rounded-[18px] bg-white p-6 text-black">
                <div className="mb-4 flex items-center justify-between">
                  <h2 className="text-2xl font-extrabold tracking-tight">Current</h2>
                  <span className="rounded-lg bg-[#e7f8ed] px-3 py-1 text-sm font-semibold text-[#118a43]">
                    {currentVisit ? 'Active' : 'Idle'}
                  </span>
                </div>
                {currentVisit ? (
                  <div className="flex h-full min-h-0 flex-1 items-center overflow-hidden rounded-2xl border-2 border-[#b8efca] bg-[#e7f8ed] p-6">
                    <div className="min-w-0">
                      <p className="truncate text-3xl font-extrabold tracking-tight">{currentVisit.patient_name}</p>
                      <p className="mt-2 text-xl font-bold text-[#118a43]">{currentVisit.id.toUpperCase()}</p>
                    </div>
                  </div>
                ) : (
                  <div className="flex h-full min-h-0 flex-1 items-center justify-center overflow-hidden rounded-2xl border-2 border-dashed border-gray-300 bg-gray-50 px-6 text-center text-xl font-semibold text-gray-400">
                    No active patient
                  </div>
                )}
              </section>

              <section className="flex min-h-0 flex-col overflow-hidden rounded-[18px] bg-white p-6 text-black">
                <div className="mb-4 flex items-center justify-between">
                  <h2 className="text-2xl font-extrabold tracking-tight">Next</h2>
                  <span className="rounded-lg bg-[#fff1d8] px-3 py-1 text-sm font-semibold text-[#b86b00]">
                    {nextVisit ? 'Queued' : 'Empty'}
                  </span>
                </div>
                {nextVisit ? (
                  <div className="flex h-full min-h-0 flex-1 items-center overflow-hidden rounded-2xl border-2 border-[#ffd89b] bg-[#fff1d8] p-6">
                    <div className="min-w-0">
                      <p className="truncate text-3xl font-extrabold tracking-tight">{nextVisit.patient_name}</p>
                      <p className="mt-2 text-xl font-bold text-[#b86b00]">{nextVisit.id.toUpperCase()}</p>
                    </div>
                  </div>
                ) : (
                  <div className="flex h-full min-h-0 flex-1 items-center justify-center overflow-hidden rounded-2xl border-2 border-dashed border-gray-300 bg-gray-50 px-6 text-center text-xl font-semibold text-gray-400">
                    No next patient
                  </div>
                )}
              </section>
            </div>

            <section className="flex min-h-0 flex-col rounded-[18px] bg-white p-6 text-black">
              <div className="mb-4 flex items-center justify-between">
                <h2 className="text-2xl font-extrabold tracking-tight">Pending List</h2>
                <span className="rounded-lg bg-[#fff1d8] px-3 py-1 text-sm font-semibold text-[#b86b00]">{pendingVisits.length}</span>
              </div>
              {pendingVisits.length > 0 ? (
                <div className="grid min-h-0 flex-1 content-start grid-cols-2 gap-4 overflow-y-auto pr-2">
                  {pendingVisits.map((visit) => (
                    <div key={visit.id} className="rounded-xl border border-[#ffd89b] bg-[#fff9ef] p-4">
                      <p className="truncate text-lg font-bold text-gray-900">{visit.patient_name}</p>
                      <p className="mt-1 text-sm font-semibold text-[#b86b00]">{visit.id.toUpperCase()}</p>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="flex min-h-[220px] flex-1 items-center justify-center rounded-2xl border-2 border-dashed border-gray-300 bg-gray-50 text-lg font-semibold text-gray-400">
                  No pending patients
                </div>
              )}
            </section>
          </div>

          <section className="flex min-h-0 flex-col rounded-[18px] bg-white p-6 text-black">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-2xl font-extrabold tracking-tight">Waiting List</h2>
              <span className="rounded-lg bg-[#f3ebf7] px-3 py-1 text-sm font-semibold text-[#5D2582]">{waitingVisits.length}</span>
            </div>
            {waitingVisits.length > 0 ? (
              <div className="grid min-h-0 flex-1 content-start grid-cols-1 gap-4 overflow-y-auto pr-2">
                {waitingVisits.map((visit) => (
                  <div key={visit.id} className="rounded-xl border border-gray-200 bg-gray-50 p-4">
                    <p className="truncate text-lg font-bold text-gray-900">{visit.patient_name}</p>
                    <p className="mt-1 text-sm font-semibold text-[#5D2582]">{visit.id.toUpperCase()}</p>
                  </div>
                ))}
              </div>
            ) : (
              <div className="flex min-h-[480px] flex-1 items-center justify-center rounded-2xl border-2 border-dashed border-gray-300 bg-gray-50 text-lg font-semibold text-gray-400">
                No waiting patients
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
