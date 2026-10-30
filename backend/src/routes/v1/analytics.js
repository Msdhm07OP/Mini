import express from 'express';
import analyticsController from '../../controllers/AnalyticsController.js';

const router = express.Router();

router.get('/overview', analyticsController.overview);
router.get('/outcomes', analyticsController.requestOutcomes);
router.get('/hall-utilisation', analyticsController.hallUtilisation);
router.get('/venue-utilisation', analyticsController.venueUtilisation);
router.get('/resource-demand', analyticsController.resourceDemand);
router.get('/demand-heatmap', analyticsController.demandHeatmap);
router.get('/rejections', analyticsController.rejectionAnalysis);
router.get('/lifecycle', analyticsController.lifecycleTrends);
router.get('/data-quality', analyticsController.dataQuality);
router.get('/export/:dataset', analyticsController.exportCsv.bind(analyticsController));

export default router;
