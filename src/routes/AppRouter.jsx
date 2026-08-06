export const AppRouter = {
  defaultRoute: '/cover',
  routes: {
    '/cover': 'CoverPage',
    '/business-driver': 'BusinessDriverPage',
    '/primary-dashboard': 'PrimaryDashboard',
    '/client-dashboard': 'ClientDashboard',
  },
  navOnPages: ['/business-driver', '/primary-dashboard', '/client-dashboard'],
};
