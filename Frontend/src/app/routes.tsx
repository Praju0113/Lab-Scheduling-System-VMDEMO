import { createBrowserRouter } from "react-router";
import LoginPage from "./pages/RoleSelection";
import ReceptionistDashboard from "./pages/ReceptionistDashboard";
import LabSpecialistDashboard from "./pages/LabSpecialistDashboard";
import AdminDashboard from "./pages/AdminDashboard";
import SuperAdminDashboard from "./pages/SuperAdminDashboard";
import QueueDisplay from "./pages/QueueDisplay";
import LabSpecificQueueDisplay from "./pages/LabSpecificQueueDisplay";
import GroupQueueDisplay from "./pages/GroupQueueDisplay";

import { ProtectedRoute } from "./components/ProtectedRoute";

export const router = createBrowserRouter([
  {
    path: "/",
    Component: LoginPage,
  },
  {
    path: "/receptionist",
    Component: () => <ProtectedRoute allowedRoles={['Receptionist']} />,
    children: [
      {
        path: "",
        Component: ReceptionistDashboard,
      }
    ]
  },
  {
    path: "/lab-specialist",
    Component: () => <ProtectedRoute allowedRoles={['LabSpecialist']} />,
    children: [
      {
        path: "",
        Component: LabSpecialistDashboard,
      }
    ]
  },
  {
    path: "/admin",
    Component: () => <ProtectedRoute allowedRoles={['Admin']} />,
    children: [
      {
        path: "",
        Component: AdminDashboard,
      }
    ]
  },
  {
    path: "/super-admin",
    Component: () => <ProtectedRoute allowedRoles={['SuperAdmin']} />,
    children: [
      {
        path: "",
        Component: SuperAdminDashboard,
      }
    ]
  },
  {
    path: "/queue-display",
    Component: QueueDisplay,
  },
  {
    path: "/queue-display/lab/:labId",
    Component: LabSpecificQueueDisplay,
  },
  {
    path: "/queue-display/group/:groupId",
    Component: GroupQueueDisplay,
  },
]);
