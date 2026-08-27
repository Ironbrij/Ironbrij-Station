import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { onAuthStateChanged, signOut, type User } from "firebase/auth";
import {
  collection,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  query,
  setDoc,
  where,
} from "firebase/firestore";
import { auth, db, firebaseConfigured } from "./firebase";
import { COMPANY_ID, type Company, type Employee } from "./types";
import { resolveProfilePhoto } from "./profile-photo";
import { getEmployeeCompanyIds, getEmployeeForCompany } from "./company-context";

interface AuthState {
  user: User | null;
  isAdmin: boolean;
  employee: Employee | null;
  company: Company | null;
  companies: Company[];
  activeCompanyId: string;
  setActiveCompanyId: (companyId: string) => void;
  loading: boolean;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
}

const Ctx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [employee, setEmployee] = useState<Employee | null>(null);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [activeCompanyId, setActiveCompanyIdState] = useState(COMPANY_ID);
  const [loading, setLoading] = useState(true);

  async function hydrate(u: User) {
    const userEmail = u.email ? u.email.toLowerCase().trim() : "";
    const authPhotoUrl = resolveProfilePhoto(u);
    const ADMIN_EMAILS = [
      "pabibek9@gmail.com",
      "bibekparajuli05@gmail.com",
      "louis@ironbrij.com.au",
    ];
    const isEmailAdmin = Boolean(userEmail && ADMIN_EMAILS.includes(userEmail));

    // Auto-save user to users collection in Firestore
    setDoc(
      doc(db(), "users", u.uid),
      {
        uid: u.uid,
        name: u.displayName || (userEmail ? userEmail.split("@")[0] : "User"),
        email: userEmail,
        ...(authPhotoUrl ? { photoUrl: authPhotoUrl } : {}),
        lastLogin: new Date().toISOString(),
      },
      { merge: true },
    ).catch(() => {});

    try {
      // Parallelize Firestore queries for maximum speed
      const [adminResult, empResult] = await Promise.allSettled([
        getDoc(doc(db(), "admins", u.uid)),
        getDoc(doc(db(), "employees", u.uid)),
      ]);

      const adminSnap = adminResult.status === "fulfilled" ? adminResult.value : null;
      const adminStatus = (adminSnap && adminSnap.exists()) || isEmailAdmin;
      setIsAdmin(adminStatus);

      if (adminStatus && (!adminSnap || !adminSnap.exists())) {
        setDoc(
          doc(db(), "admins", u.uid),
          { role: "owner", email: userEmail, createdAt: new Date().toISOString() },
          { merge: true },
        ).catch(() => {});
      }

      const empSnap = empResult.status === "fulfilled" ? empResult.value : null;
      if (empSnap && empSnap.exists()) {
        const empData = empSnap.data() as Omit<Employee, "id">;
        const employeeUpdates: Partial<Employee> = {};
        if (userEmail && empData.email?.toLowerCase() !== userEmail) {
          employeeUpdates.email = userEmail;
        }
        if (authPhotoUrl && empData.photoUrl !== authPhotoUrl) {
          employeeUpdates.photoUrl = authPhotoUrl;
        }
        if (Object.keys(employeeUpdates).length) {
          Object.assign(empData, employeeUpdates);
          setDoc(doc(db(), "employees", u.uid), employeeUpdates, { merge: true }).catch(() => {});
        }
        setEmployee({ id: empSnap.id, ...empData });
      } else if (userEmail) {
        const q = query(collection(db(), "employees"), where("email", "==", userEmail));
        const querySnap = await getDocs(q);
        if (!querySnap.empty) {
          const matchDoc = querySnap.docs[0];
          const empData = matchDoc.data();
          const updatedEmp = {
            id: matchDoc.id,
            ...empData,
            email: userEmail,
            authUid: u.uid,
            photoUrl: authPhotoUrl || resolveProfilePhoto(empData as Omit<Employee, "id">) || "",
          };
          setEmployee(updatedEmp as Employee);
        } else {
          setEmployee(null);
        }
      } else {
        setEmployee(null);
      }
    } catch (err) {
      console.error("Hydration error:", err);
      setIsAdmin(isEmailAdmin);
    }
  }

  // Real-time synchronization of employee document (instant settings updates)
  useEffect(() => {
    if (!user || !employee?.id) return;
    const unsub = onSnapshot(doc(db(), "employees", employee.id), (snap) => {
      if (snap.exists()) {
        const data = snap.data() as Omit<Employee, "id">;
        setEmployee((prev) => (prev ? { ...prev, ...data, id: snap.id } : { id: snap.id, ...data }));
      }
    });
    return unsub;
  }, [user?.uid, employee?.id]);

  useEffect(() => {
    if (!firebaseConfigured) {
      setLoading(false);
      return;
    }
    const unsub = onAuthStateChanged(auth(), (u) => {
      setUser(u);
      if (u) {
        const userEmail = u.email ? u.email.toLowerCase().trim() : "";
        const ADMIN_EMAILS = [
          "pabibek9@gmail.com",
          "bibekparajuli05@gmail.com",
          "louis@ironbrij.com.au",
        ];
        const isEmailAdmin = Boolean(userEmail && ADMIN_EMAILS.includes(userEmail));
        setIsAdmin(isEmailAdmin);
        setLoading(false); // Unblock UI immediately (0ms wait)
        hydrate(u).catch(() => {});
      } else {
        setIsAdmin(false);
        setEmployee(null);
        setLoading(false);
      }
    });
    return unsub;
  }, []);

  useEffect(() => {
    if (!firebaseConfigured || (!employee && !isAdmin)) {
      setCompanies([]);
      return;
    }

    if (isAdmin) {
      return onSnapshot(collection(db(), "companies"), (snapshot) => {
        setCompanies(
          snapshot.docs.map((item) => ({
            id: item.id,
            ...(item.data() as Omit<Company, "id">),
          })),
        );
      });
    }

    let active = true;
    const companyIds = getEmployeeCompanyIds(employee);
    Promise.all(companyIds.map((companyId) => getDoc(doc(db(), "companies", companyId))))
      .then((snapshots) => {
        if (!active) return;
        setCompanies(
          snapshots
            .filter((snapshot) => snapshot.exists())
            .map((snapshot) => ({
              id: snapshot.id,
              ...(snapshot.data() as Omit<Company, "id">),
            })),
        );
      })
      .catch((error) => console.error("Company context hydration failed:", error));
    return () => {
      active = false;
    };
  }, [employee, isAdmin]);

  const availableCompanyIds = useMemo(() => {
    if (isAdmin && companies.length > 0) {
      return companies.map((item) => item.id || COMPANY_ID);
    }
    return getEmployeeCompanyIds(employee);
  }, [companies, employee, isAdmin]);

  useEffect(() => {
    if (!user || availableCompanyIds.length === 0) return;
    const storageKey = `active_company_id:${user.uid}`;
    const saved = typeof window === "undefined" ? null : window.localStorage.getItem(storageKey);
    const preferred =
      saved && availableCompanyIds.includes(saved)
        ? saved
        : employee?.companyId && availableCompanyIds.includes(employee.companyId)
          ? employee.companyId
          : availableCompanyIds[0];
    setActiveCompanyIdState(preferred);
  }, [availableCompanyIds, employee?.companyId, user]);

  const setActiveCompanyId = useCallback(
    (companyId: string) => {
      if (!availableCompanyIds.includes(companyId)) return;
      setActiveCompanyIdState(companyId);
      if (user && typeof window !== "undefined") {
        window.localStorage.setItem(`active_company_id:${user.uid}`, companyId);
      }
    },
    [availableCompanyIds, user],
  );

  const company = useMemo(
    () => companies.find((item) => (item.id || COMPANY_ID) === activeCompanyId) || null,
    [activeCompanyId, companies],
  );
  const scopedEmployee = useMemo(() => {
    if (employee) return getEmployeeForCompany(employee, activeCompanyId);
    if (isAdmin && user) {
      const userEmail = user.email ? user.email.toLowerCase().trim() : "";
      return {
        id: user.uid,
        authUid: user.uid,
        name: user.displayName || (userEmail ? userEmail.split("@")[0] : "Admin"),
        email: userEmail,
        status: "active",
        inviteStatus: "accepted",
        timezone: "Asia/Manila",
        shiftTimezone: "Australia/Sydney",
        shiftStartTime: "09:00",
        shiftEndTime: "17:00",
        workingDays: [0, 1, 2, 3, 4, 5, 6],
        jobTitle: "Administrator",
        reportingRequirement: "sod_eod",
      } as Employee;
    }
    return null;
  }, [activeCompanyId, employee, isAdmin, user]);

  const value: AuthState = {
    user,
    isAdmin,
    employee: scopedEmployee,
    company,
    companies,
    activeCompanyId,
    setActiveCompanyId,
    loading,
    logout: async () => {
      if (firebaseConfigured) await signOut(auth());
    },
    refresh: async () => {
      if (user) await hydrate(user);
    },
  };

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth() {
  const v = useContext(Ctx);
  if (!v) throw new Error("useAuth outside AuthProvider");
  return v;
}
