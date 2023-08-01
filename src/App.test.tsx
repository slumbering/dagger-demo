import React from 'react';
import { render, screen } from '@testing-library/react';
import App from './App';

//tests
test('renders learn react link', () => {
  render(<App />);
  const linkElement = screen.getByText(/Learn Dagger/i);
  expect(linkElement).toBeInTheDocument();
});
