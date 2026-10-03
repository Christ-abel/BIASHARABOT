import React, { useState } from 'react';

/** Password input with a Show / Hide control so the owner can check what they typed. */
export default function PasswordField({
  id,
  label,
  value,
  onChange,
  placeholder,
  autoComplete = 'current-password',
  disabled = false,
  required = true
}) {
  const [visible, setVisible] = useState(false);

  return (
    <div className="form-group">
      {label && <label htmlFor={id}>{label}</label>}
      <div className="password-field">
        <input
          id={id}
          type={visible ? 'text' : 'password'}
          className="form-input"
          placeholder={placeholder}
          value={value}
          onChange={onChange}
          autoComplete={autoComplete}
          disabled={disabled}
          required={required}
        />
        <button
          type="button"
          className="password-toggle"
          onClick={() => setVisible((open) => !open)}
          aria-pressed={visible}
          aria-label={visible ? 'Hide password' : 'Show password'}
          disabled={disabled}
        >
          {visible ? 'Hide' : 'Show'}
        </button>
      </div>
    </div>
  );
}
