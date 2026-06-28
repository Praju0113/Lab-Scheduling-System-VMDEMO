import { initializeApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';

const firebaseConfig = {
  apiKey: 'AIzaSyBfr0e99eQ-feo7x-WwJRnXGPgw45GhXqs',
  authDomain: 'lab-scheduling-system-tdai.firebaseapp.com',
  projectId: 'lab-scheduling-system-tdai',
  storageBucket: 'lab-scheduling-system-tdai.firebasestorage.app',
  messagingSenderId: '579911205793',
  appId: '1:579911205793:web:e6e276cb8a5bdc5ff401e0',
};

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);