import {
  ArcElement,
  CategoryScale,
  Chart, Colors,
  Legend,
  LinearScale,
  LineController,
  LineElement,
  PointElement,
  TimeScale,
  Title,
  Tooltip,
} from 'chart.js';
import 'chartjs-adapter-luxon';

export default defineNuxtPlugin(() => {
  Chart.register(ArcElement, Title, Tooltip, Legend, LineElement, CategoryScale, LinearScale, PointElement, LineController, TimeScale, Colors);
});