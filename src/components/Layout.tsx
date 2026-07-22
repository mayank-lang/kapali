import React, { type ReactNode } from 'react';

type LayoutProps = {
  children: ReactNode;
};

export const Layout: React.FC<LayoutProps> = ({ children }) => {
  return (
    <div className="layout-root">
      {children}
    </div>
  );
};

export default Layout;
