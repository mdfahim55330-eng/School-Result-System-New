/** Tailwind is built ahead of time (npm run build:css) and the result is saved in public/css/app.css,
 *  so the website needs no build step on the server and works with a strict security policy. */
module.exports = {
    content: ["./public/**/*.html", "./public/js/**/*.js", "./src/views/**/*.js"],
    theme: {
        extend: {
            fontFamily: {
                sans: ['"Hind Siliguri"', "ui-sans-serif", "system-ui", "-apple-system", "Segoe UI", "Roboto", "Arial", "sans-serif"]
            },
            colors: {
                brand: {
                    50: "#eef4ff", 100: "#dbe7ff", 200: "#bcd2ff", 300: "#8fb4ff", 400: "#5c8cf8",
                    500: "#3768ee", 600: "#234bd3", 700: "#1d3cac", 800: "#1e3a8a", 900: "#1b2f6b", 950: "#121d44"
                }
            },
            boxShadow: {
                soft: "0 1px 2px rgba(15,23,42,.04), 0 4px 16px rgba(15,23,42,.06)"
            }
        }
    },
    plugins: [require("@tailwindcss/forms")]
};
