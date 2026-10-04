import React from "react";

export default function Image({ alt = "", ...props }) {
  // next/image mock for unit tests
  return <img alt={alt} {...props} />;
}
